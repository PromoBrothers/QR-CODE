// Garantir que crypto está disponível globalmente
if (typeof global.crypto === 'undefined') {
    global.crypto = require('crypto');
}

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const P = require('pino');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const FLASK_API = process.env.FLASK_API || 'http://localhost:5000';

// Cache para QR Code
const qrCodeCache = new NodeCache({ stdTTL: 300 });

let sock;
let qrCodeData = null;
let isConnected = false;
let connectionState = 'disconnected';
let monitoredGroups = new Set();
let capturedMessages = []; // Array para armazenar mensagens capturadas

// Arquivo de configuração
const CONFIG_FILE = path.join(__dirname, 'monitored_groups.json');

// Carregar grupos monitorados
function loadMonitoredGroups() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            monitoredGroups = new Set(data.groups || []);
            console.log(`📋 ${monitoredGroups.size} grupo(s) carregado(s) para monitoramento`);
        }
    } catch (error) {
        console.error('❌ Erro ao carregar grupos:', error);
    }
}

// Salvar grupos monitorados
function saveMonitoredGroups() {
    try {
        const data = {
            groups: Array.from(monitoredGroups),
            lastUpdate: new Date().toISOString()
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
        console.log('💾 Grupos salvos');
    } catch (error) {
        console.error('❌ Erro ao salvar grupos:', error);
    }
}

// Configurar conexão WhatsApp
async function connectToWhatsApp() {
    try {
        console.log('🔄 Iniciando conexão com WhatsApp...');

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        console.log('✅ Estado de autenticação carregado');

        const { version } = await fetchLatestBaileysVersion();
        console.log(`✅ Versão do Baileys: ${version.join('.')}`);

        // Verificar se já está autenticado
        const isAuthenticated = !!state.creds?.registered;
        console.log(`🔐 Autenticado: ${isAuthenticated}`);

        sock = makeWASocket({
            version,
            logger: P({ level: 'silent' }),
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
            },
            browser: ['Promo Brothers', 'Chrome', '10.0']
        });

        console.log('✅ Socket criado com sucesso');

    // Handler de conexão
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        console.log('📡 Connection update:', {
            connection,
            hasQR: !!qr,
            qrLength: qr ? qr.length : 0
        });

        if (qr) {
            qrCodeData = qr;
            connectionState = 'qr';
            console.log('📱 QR Code gerado! Aguardando escaneamento...');
            console.log('   Tamanho do QR:', qr.length, 'caracteres');

            // Gerar QR Code como imagem
            try {
                const qrImage = await QRCode.toDataURL(qr);
                qrCodeCache.set('qrcode', qrImage);
                console.log('✅ QR Code convertido para imagem e armazenado no cache');
                console.log('   Tamanho da imagem:', qrImage.length, 'caracteres');
            } catch (err) {
                console.error('❌ Erro ao gerar QR Code:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;

            console.log('❌ Conexão fechada.');
            console.log('   Status Code:', statusCode);
            console.log('   Erro:', errorMessage);

            isConnected = false;
            connectionState = 'disconnected';
            qrCodeData = null;
            qrCodeCache.del('qrcode');

            // Se o status code é undefined ou erro de crypto, limpar autenticação
            if (statusCode === undefined || errorMessage?.includes('crypto')) {
                console.log('⚠️  Erro de conexão detectado - limpando autenticação...');
                console.log('   Mensagem de erro:', errorMessage);
                const authPath = path.join(__dirname, 'auth_info_baileys');
                try {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('🗑️  Autenticação removida.');
                    }
                } catch (err) {
                    console.error('❌ Erro ao remover autenticação:', err);
                }

                // Tentar reconectar após 3 segundos
                console.log('🔄 Tentando nova conexão em 3 segundos...');
                setTimeout(() => connectToWhatsApp(), 3000);
                return;
            }

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('   Reconectar?', shouldReconnect);

            if (shouldReconnect) {
                console.log('🔄 Reconectando em 5 segundos...');
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                console.log('🚫 Logout detectado. Não reconectando automaticamente.');
            }
        } else if (connection === 'open') {
            console.log('✅ Conectado ao WhatsApp com sucesso!');
            isConnected = true;
            connectionState = 'connected';
            qrCodeData = null;
            qrCodeCache.del('qrcode');
        } else if (connection === 'connecting') {
            console.log('🔄 Conectando ao WhatsApp...');
            connectionState = 'connecting';
        }
    });

    // Salvar credenciais
    sock.ev.on('creds.update', saveCreds);

    // Monitorar mensagens dos grupos
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const message of messages) {
            try {
                // Ignorar mensagens próprias
                if (message.key.fromMe) continue;

                const chatId = message.key.remoteJid;

                // Verificar se é de um grupo monitorado
                if (!chatId.includes('@g.us')) continue;
                if (!monitoredGroups.has(chatId)) continue;

                // Extrair texto da mensagem
                const text = message.message?.conversation ||
                            message.message?.extendedTextMessage?.text ||
                            message.message?.imageMessage?.caption ||
                            '';

                // Extrair imagem se existir
                let imageUrl = null;
                if (message.message?.imageMessage) {
                    try {
                        const buffer = await downloadMediaMessage(
                            message,
                            'buffer',
                            {},
                            {
                                logger: P({ level: 'silent' }),
                                reuploadRequest: sock.updateMediaMessage
                            }
                        );
                        // Converter buffer para base64
                        imageUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
                        console.log('   📷 Imagem capturada');
                    } catch (err) {
                        console.error('   ❌ Erro ao baixar imagem:', err.message);
                    }
                }

                if (!text && !imageUrl) continue;

                // Obter nome do grupo
                let groupName = chatId;
                try {
                    const groupMetadata = await sock.groupMetadata(chatId);
                    groupName = groupMetadata.subject;
                } catch (err) {
                    console.error('Erro ao obter metadata do grupo:', err);
                }

                // Obter nome do remetente
                let senderName = message.pushName || 'Desconhecido';

                console.log(`\n📩 Nova mensagem no grupo monitorado:`);
                console.log(`   Grupo: ${groupName}`);
                console.log(`   De: ${senderName}`);
                console.log(`   Texto: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

                // Armazenar mensagem
                const capturedMessage = {
                    id: message.key.id,
                    timestamp: new Date().toISOString(),
                    groupId: chatId,
                    groupName: groupName,
                    sender: senderName,
                    senderId: message.key.participant || message.key.remoteJid,
                    text: text,
                    imageUrl: imageUrl
                };

                capturedMessages.unshift(capturedMessage);

                // Limitar a 500 mensagens
                if (capturedMessages.length > 500) {
                    capturedMessages.pop();
                }

            } catch (error) {
                console.error('❌ Erro ao processar mensagem:', error);
            }
        }
    });

    } catch (error) {
        console.error('❌ Erro ao conectar ao WhatsApp:', error);
        connectionState = 'error';
        isConnected = false;

        // Tentar reconectar após erro
        console.log('🔄 Tentando reconectar em 10 segundos...');
        setTimeout(() => connectToWhatsApp(), 10000);
    }
}

// === ROTAS DA API ===

// Status da conexão
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        state: connectionState,
        monitoredGroups: monitoredGroups.size
    });
});

// Obter QR Code
app.get('/qr', (req, res) => {
    const qrImage = qrCodeCache.get('qrcode');

    console.log('📲 Requisição de QR Code recebida');
    console.log('   Estado atual:', connectionState);
    console.log('   Conectado:', isConnected);
    console.log('   QR no cache:', !!qrImage);

    if (qrImage) {
        console.log('   ✅ Retornando QR Code do cache');
        res.json({ qr: qrImage, state: connectionState });
    } else if (isConnected) {
        console.log('   ✅ Já conectado');
        res.json({ message: 'Já conectado', state: 'connected' });
    } else {
        console.log('   ⚠️ QR Code não disponível ainda');
        res.json({
            message: 'QR Code não disponível. Aguardando conexão...',
            state: connectionState,
            hint: 'O QR Code será gerado automaticamente. Aguarde alguns segundos e recarregue a página.'
        });
    }
});

// Listar grupos disponíveis
app.get('/groups', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(group => ({
            id: group.id,
            name: group.subject,
            participants: group.participants.length,
            monitored: monitoredGroups.has(group.id)
        }));

        res.json({ groups: groupList });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Adicionar grupo ao monitoramento
app.post('/groups/monitor', (req, res) => {
    try {
        const { groupId } = req.body;

        if (!groupId) {
            return res.status(400).json({ error: 'groupId é obrigatório' });
        }

        monitoredGroups.add(groupId);
        saveMonitoredGroups();

        console.log(`✅ Grupo adicionado ao monitoramento: ${groupId}`);

        res.json({
            success: true,
            message: 'Grupo adicionado ao monitoramento',
            monitoredGroups: monitoredGroups.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Remover grupo do monitoramento
app.delete('/groups/monitor/:groupId', (req, res) => {
    try {
        const { groupId} = req.params;

        monitoredGroups.delete(groupId);
        saveMonitoredGroups();

        console.log(`🗑️ Grupo removido do monitoramento: ${groupId}`);

        res.json({
            success: true,
            message: 'Grupo removido do monitoramento',
            monitoredGroups: monitoredGroups.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obter mensagens capturadas
app.get('/messages', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const messages = capturedMessages.slice(0, limit);

        res.json({
            success: true,
            count: messages.length,
            total: capturedMessages.length,
            messages
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Criar novo grupo
app.post('/groups/create', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        const { groupName, participants } = req.body;

        if (!groupName || !participants || !Array.isArray(participants)) {
            return res.status(400).json({
                error: 'groupName e participants (array) são obrigatórios'
            });
        }

        // Criar grupo
        const group = await sock.groupCreate(groupName, participants);

        console.log(`✅ Grupo criado: ${groupName} (${group.id})`);

        res.json({
            success: true,
            message: 'Grupo criado com sucesso',
            group: {
                id: group.id,
                name: groupName,
                participants: participants.length
            }
        });
    } catch (error) {
        console.error('❌ Erro ao criar grupo:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enviar mensagem para grupo
app.post('/groups/send-message', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        const { groupId, message, imageUrl } = req.body;

        if (!groupId || !message) {
            return res.status(400).json({
                error: 'groupId e message são obrigatórios'
            });
        }

        // Enviar mensagem
        if (imageUrl) {
            await sock.sendMessage(groupId, {
                image: { url: imageUrl },
                caption: message
            });
        } else {
            await sock.sendMessage(groupId, {
                text: message
            });
        }

        console.log(`✅ Mensagem enviada para ${groupId}`);

        res.json({
            success: true,
            message: 'Mensagem enviada com sucesso'
        });
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error);
        res.status(500).json({ error: error.message });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }

        // Remover pasta de autenticação
        const authPath = path.join(__dirname, 'auth_info_baileys');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        isConnected = false;
        connectionState = 'disconnected';
        qrCodeData = null;
        qrCodeCache.del('qrcode');

        res.json({ success: true, message: 'Logout realizado com sucesso' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para integração com scraper - enviar produto para grupos
app.post('/send-product', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp não conectado' });
        }

        const { groupIds, message, imageUrl } = req.body;

        if (!groupIds || !Array.isArray(groupIds) || !message) {
            return res.status(400).json({
                error: 'groupIds (array) e message são obrigatórios'
            });
        }

        const results = [];

        // Enviar para cada grupo
        for (const groupId of groupIds) {
            try {
                if (imageUrl) {
                    await sock.sendMessage(groupId, {
                        image: { url: imageUrl },
                        caption: message
                    });
                } else {
                    await sock.sendMessage(groupId, {
                        text: message
                    });
                }

                console.log(`✅ Produto enviado para ${groupId}`);
                results.push({ groupId, success: true });
            } catch (error) {
                console.error(`❌ Erro ao enviar para ${groupId}:`, error);
                results.push({ groupId, success: false, error: error.message });
            }
        }

        res.json({
            success: true,
            message: 'Processo concluído',
            results
        });
    } catch (error) {
        console.error('❌ Erro ao enviar produto:', error);
        res.status(500).json({ error: error.message });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor WhatsApp Monitor rodando na porta ${PORT}`);
    console.log(`📡 Flask API: ${FLASK_API}`);
    console.log(`\n📱 Funcionalidades disponíveis:`);
    console.log(`   - Leitura de QR Code`);
    console.log(`   - Criação de grupos`);
    console.log(`   - Monitoramento de mensagens`);
    console.log(`   - Envio de mensagens`);
    console.log(`   - Integração com scraper`);

    // Carregar grupos monitorados
    loadMonitoredGroups();

    // Conectar ao WhatsApp
    connectToWhatsApp().catch(err => {
        console.error('Erro ao conectar:', err);
    });
});
