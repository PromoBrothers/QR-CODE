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

// Forçar porta 3001 para WhatsApp Monitor (Flask usa 5000)
const PORT = 3001;
const FLASK_API = process.env.FLASK_API || 'http://localhost:5000';

// Suprimir erros de descriptografia e logs de sessão do console
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

console.error = (...args) => {
    const message = args.join(' ');
    // Ignorar erros Bad MAC e erros de descriptografia
    if (message.includes('Bad MAC') ||
        message.includes('Failed to decrypt') ||
        message.includes('Session error')) {
        return;
    }
    originalConsoleError.apply(console, args);
};

console.log = (...args) => {
    const message = args.join(' ');
    // Ignorar logs verbosos de sessão
    if (message.includes('Closing session') ||
        message.includes('Closing open session in favor of incoming prekey bundle') ||
        message.includes('SessionEntry')) {
        return;
    }
    originalConsoleLog.apply(console, args);
};

// Cache para QR Code
const qrCodeCache = new NodeCache({ stdTTL: 300 });

// Cache para retry de mensagens (evita erro "No sessions")
const msgRetryCounterCache = new NodeCache();

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

        // Usar versão fixa ao invés de buscar online (mais rápido e confiável)
        const version = [2, 3000, 1027934701];
        console.log(`✅ Versão do Baileys: ${version.join('.')}`);

        // Verificar se já está autenticado
        const isAuthenticated = !!state.creds?.registered;
        console.log(`🔐 Autenticado: ${isAuthenticated}`);
        console.log(`🔍 Debug: Iniciando criação do socket...`);

        // Criar logger para o socket
        const socketLogger = P({ level: 'silent' });

        sock = makeWASocket({
            version,
            logger: socketLogger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                // IMPORTANTE: makeCacheableSignalKeyStore precisa do logger para funcionar corretamente
                keys: makeCacheableSignalKeyStore(state.keys, socketLogger),
            },
            browser: ['Promo Brothers', 'Chrome', '10.0'],
            // ✅ SOLUÇÃO DEFINITIVA: Cache para retry de mensagens (ESSENCIAL para evitar "No sessions")
            msgRetryCounterCache,
            // ✅ Gerar automaticamente link de preview (evita erros)
            generateHighQualityLinkPreview: false,
            // ✅ Sincronizar histórico completo para ter todas as sessões
            syncFullHistory: false,
            // ✅ Marcar como online para manter conexão ativa
            markOnlineOnConnect: true,
            // ✅ Retry de conexão
            retryRequestDelayMs: 250,
            // ✅ getMessage DEVE retornar undefined para forçar retry correto
            getMessage: async (key) => {
                // Retorna undefined para forçar o Baileys a fazer retry correto
                return undefined;
            }
        });

        console.log('✅ Socket criado com sucesso');
        console.log('🔍 Debug: Aguardando eventos de conexão...');

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
            console.log('   Tamanho do QR:', qr.length, 'caracteres');

            // Gerar QR Code como imagem
            try {
                const qrImage = await QRCode.toDataURL(qr);
                qrCodeCache.set('qrcode', qrImage);
                console.log('✅ QR Code convertido para imagem e armazenado no cache');
                console.log('   Tamanho da imagem:', qrImage.length, 'caracteres');
            } catch (err) {
                console.error('❌ Erro ao gerar QR Code:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message;

            console.log('❌ Conexão fechada.');
            console.log('   Status Code:', statusCode);
            console.log('   Erro:', errorMessage);

            isConnected = false;
            connectionState = 'disconnected';
            qrCodeData = null;
            qrCodeCache.del('qrcode');

            // Se o status code é undefined ou erro de crypto, limpar autenticação
            if (statusCode === undefined || errorMessage?.includes('crypto')) {
                console.log('⚠️  Erro de conexão detectado - limpando autenticação...');
                console.log('   Mensagem de erro:', errorMessage);
                const authPath = path.join(__dirname, 'auth_info_baileys');
                try {
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('🗑️  Autenticação removida.');
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
            console.log('   Reconectar?', shouldReconnect);

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
        console.log(`📨 Mensagens recebidas: ${messages.length}, tipo: ${type}`);

        // ✅ CORRIGIDO: Aceitar 'notify' (mensagens novas) E 'append' (mensagens históricas)
        if (type !== 'notify' && type !== 'append') {
            console.log(`⏭️ Tipo ignorado: ${type}`);
            return;
        }

        for (const message of messages) {
            try {
                // Ignorar mensagens próprias
                if (message.key.fromMe) {
                    console.log('⏭️ Mensagem própria - ignorando');
                    continue;
                }

                const chatId = message.key.remoteJid;

                // Verificar se é de um grupo monitorado
                if (!chatId.includes('@g.us')) {
                    console.log(`⏭️ Não é grupo: ${chatId}`);
                    continue;
                }

                console.log(`\n📱 Mensagem do grupo: ${chatId}`);
                console.log(`📋 Grupos monitorados: ${Array.from(monitoredGroups).join(', ')}`);

                if (!monitoredGroups.has(chatId)) {
                    console.log(`⏭️ Grupo não monitorado: ${chatId}`);
                    continue;
                }

                console.log(`✅ Grupo monitorado! Processando mensagem...`);
                console.log(`🔍 Estrutura da mensagem:`, JSON.stringify(Object.keys(message), null, 2));
                console.log(`🔍 Tipos de conteúdo:`, message.message ? Object.keys(message.message) : 'SEM message');

                // ✅ CORRIGIDO: Extrair conteúdo de ephemeralMessage (mensagens temporárias)
                // As mensagens temporárias encapsulam o conteúdo real dentro de ephemeralMessage.message
                let msgContent = message.message;
                if (msgContent?.ephemeralMessage?.message) {
                    console.log(`📦 Desencapsulando ephemeralMessage...`);
                    msgContent = msgContent.ephemeralMessage.message;
                    console.log(`🔍 Tipos de conteúdo (após desencapsular):`, Object.keys(msgContent));
                }

                // Também verificar viewOnceMessage e viewOnceMessageV2
                if (msgContent?.viewOnceMessage?.message) {
                    console.log(`📦 Desencapsulando viewOnceMessage...`);
                    msgContent = msgContent.viewOnceMessage.message;
                }
                if (msgContent?.viewOnceMessageV2?.message) {
                    console.log(`📦 Desencapsulando viewOnceMessageV2...`);
                    msgContent = msgContent.viewOnceMessageV2.message;
                }

                // ✅ CORRIGIDO: Extrair texto de MÚLTIPLOS tipos de mensagem
                let text = '';
                if (msgContent) {
                    text = msgContent.conversation ||
                           msgContent.extendedTextMessage?.text ||
                           msgContent.imageMessage?.caption ||
                           msgContent.videoMessage?.caption ||
                           msgContent.documentMessage?.caption ||
                           msgContent.listResponseMessage?.singleSelectReply?.selectedRowId ||
                           msgContent.buttonsResponseMessage?.selectedButtonId ||
                           '';
                }

                console.log(`📝 Texto extraído: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);

                // Extrair imagem se existir
                let imageUrl = null;
                // Usar msgContent para verificar imageMessage (pode estar dentro de ephemeralMessage)
                const imageMessage = msgContent?.imageMessage || message.message?.imageMessage;
                if (imageMessage) {
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
                        console.log('   📷 Imagem capturada');
                    } catch (err) {
                        console.error('   ❌ Erro ao baixar imagem:', err.message);
                    }
                }

                // ✅ CORRIGIDO: Aceitar mensagens com APENAS texto OU APENAS imagem
                if (!text && !imageUrl) {
                    console.log('⏭️ Mensagem sem texto e sem imagem - ignorando');
                    continue;
                }

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
                console.log(`   Grupo: ${groupName}`);
                console.log(`   De: ${senderName}`);
                console.log(`   Texto: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

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

                // ============================================================
                // CLONAGEM AUTOMATICA: Envia para Flask processar e agendar
                // ============================================================
                if (text || imageUrl) {
                    try {
                        console.log('[AUTO-CLONE] Processando mensagem automaticamente...');

                        const cloneResponse = await axios.post(FLASK_API + '/whatsapp/clone-message', {
                            mensagem: text || '',
                            imagem_url: imageUrl,
                            grupo_origem: groupId,
                            grupo_origem_nome: groupName
                        }, { timeout: 30000 });

                        if (cloneResponse.data && cloneResponse.data.success) {
                            console.log('[AUTO-CLONE] Mensagem clonada e agendada automaticamente!');
                            if (cloneResponse.data.links_substituidos && cloneResponse.data.links_substituidos.length > 0) {
                                cloneResponse.data.links_substituidos.forEach(link => {
                                    console.log('[AUTO-CLONE]   - ' + link.plataforma + ': link substituido');
                                });
                            }
                        } else {
                            console.log('[AUTO-CLONE] Resposta:', cloneResponse.data);
                        }
                    } catch (cloneError) {
                        console.error('[AUTO-CLONE] Erro ao clonar automaticamente:', cloneError.message);
                    }
                }

            } catch (error) {
                console.error('Erro ao processar mensagem:', error);
            }
        }
    });

    } catch (error) {
        console.error('❌ Erro ao conectar ao WhatsApp:', error);
        console.error('   Stack trace:', error.stack);
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
    console.log('   Estado atual:', connectionState);
    console.log('   Conectado:', isConnected);
    console.log('   QR no cache:', !!qrImage);

    if (qrImage) {
        console.log('   ✅ Retornando QR Code do cache');
        res.json({ qr: qrImage, state: connectionState });
    } else if (isConnected) {
        console.log('   ✅ Já conectado');
        res.json({ message: 'Já conectado', state: 'connected' });
    } else {
        console.log('   ⚠️ QR Code não disponível ainda');
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
        // Garantir que o erro retorna JSON
        res.status(500).json({ error: error.message });
    }
});

// CORRIGIDO: Rota para adicionar grupo ao monitoramento
app.post('/monitor', (req, res) => {
    try {
        const { groupId } = req.body;

        if (!groupId) {
            return res.status(400).json({ success: false, error: 'groupId é obrigatório' });
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
        // Garantir que o erro retorna JSON
        res.status(500).json({ success: false, error: error.message });
    }
});

// CORRIGIDO: Rota para remover grupo do monitoramento
app.post('/unmonitor', (req, res) => {
    try {
        const { groupId } = req.body;

        if (!groupId) {
            return res.status(400).json({ success: false, error: 'groupId é obrigatório' });
        }

        const wasMonitored = monitoredGroups.delete(groupId);
        
        if (wasMonitored) {
            saveMonitoredGroups();
            console.log(`🗑️ Grupo removido do monitoramento: ${groupId}`);
            res.json({
                success: true,
                message: 'Grupo removido do monitoramento',
                monitoredGroups: monitoredGroups.size
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Grupo não estava monitorado'
            });
        }
    } catch (error) {
        // Garantir que o erro retorna JSON
        res.status(500).json({ success: false, error: error.message });
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

// ✅ Função auxiliar para enviar mensagem com retry automático
async function sendMessageWithRetry(groupId, messageContent, maxRetries = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`📤 Tentativa ${attempt}/${maxRetries} de envio para ${groupId}...`);

            const result = await sock.sendMessage(groupId, messageContent);
            console.log(`✅ Mensagem enviada com sucesso na tentativa ${attempt}!`);
            return result;

        } catch (error) {
            lastError = error;
            console.error(`❌ Tentativa ${attempt} falhou:`, error.message);

            // Se for SessionError, aguardar um pouco antes de tentar novamente
            if (error.message && error.message.includes('SessionError')) {
                console.log(`⚠️ SessionError detectado. Aguardando ${attempt * 2}s antes de retry...`);
                await new Promise(resolve => setTimeout(resolve, attempt * 2000));
            } else if (attempt < maxRetries) {
                // Outros erros, aguardar 1s
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    throw lastError;
}

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

        console.log(`📱 Iniciando envio para grupo: ${groupId}`);

        // ✅ SOLUÇÃO DEFINITIVA: Usar função com retry automático
        let messageContent;
        if (imageUrl) {
            messageContent = {
                image: { url: imageUrl },
                caption: message
            };
        } else {
            messageContent = { text: message };
        }

        await sendMessageWithRetry(groupId, messageContent);

        res.json({
            success: true,
            message: 'Mensagem enviada com sucesso'
        });

    } catch (error) {
        console.error('❌ Erro ao enviar mensagem após todas tentativas:', error);
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

        // ✅ SOLUÇÃO: Preparar conteúdo da mensagem uma vez
        let messageContent;
        if (imageUrl) {
            messageContent = {
                image: { url: imageUrl },
                caption: message
            };
        } else {
            messageContent = { text: message };
        }

        // Enviar para cada grupo usando a função com retry
        for (const groupId of groupIds) {
            try {
                await sendMessageWithRetry(groupId, messageContent);
                console.log(`✅ Produto enviado para ${groupId}`);
                results.push({ groupId, success: true });
            } catch (error) {
                console.error(`❌ Erro ao enviar para ${groupId}:`, error.message);
                results.push({ groupId, success: false, error: error.message });
            }

            // Aguardar 1s entre grupos para evitar rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
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
    console.log(`   - Leitura de QR Code`);
    console.log(`   - Criação de grupos`);
    console.log(`   - Monitoramento de mensagens`);
    console.log(`   - Envio de mensagens`);
    console.log(`   - Integração com scraper`);

    // Carregar grupos monitorados
    loadMonitoredGroups();

    // Conectar ao WhatsApp
    connectToWhatsApp().catch(err => {
        console.error('Erro ao conectar:', err);
    });
});
// ============================================================================
// ROTAS PARA CLONAGEM DE MENSAGENS COM AFILIADO
// ============================================================================

// Clonar uma mensagem especifica (substitui links por afiliados e agenda)
app.post('/clone-message', async (req, res) => {
    try {
        const { messageId, mensagem, imagem_url, grupo_origem, grupo_origem_nome } = req.body;

        let textoMensagem = mensagem;
        let imagemUrl = imagem_url;
        let grupoOrigem = grupo_origem;
        let grupoOrigemNome = grupo_origem_nome;

        if (messageId) {
            const msgCapturada = capturedMessages.find(m => m.id === messageId);
            if (!msgCapturada) {
                return res.status(404).json({ success: false, error: 'Mensagem nao encontrada' });
            }
            textoMensagem = msgCapturada.text;
            imagemUrl = msgCapturada.imageUrl;
            grupoOrigem = msgCapturada.groupId;
            grupoOrigemNome = msgCapturada.groupName;
        }

        if (!textoMensagem && !imagemUrl) {
            return res.status(400).json({ success: false, error: 'Mensagem ou imagem e obrigatoria' });
        }

        console.log('[CLONE] Clonando mensagem do grupo:', grupoOrigemNome);

        try {
            const flaskResponse = await axios.post(FLASK_API + '/whatsapp/clone-message', {
                mensagem: textoMensagem || '',
                imagem_url: imagemUrl,
                grupo_origem: grupoOrigem,
                grupo_origem_nome: grupoOrigemNome
            }, { timeout: 30000 });

            console.log('[CLONE] Mensagem clonada e agendada!');

            res.json({
                success: true,
                message: 'Mensagem clonada e agendada para envio!',
                data: flaskResponse.data
            });

        } catch (flaskError) {
            console.error('[CLONE] Erro ao comunicar com Flask:', flaskError.message);
            res.status(500).json({
                success: false,
                error: 'Erro ao processar clonagem: ' + flaskError.message
            });
        }

    } catch (error) {
        console.error('[CLONE] Erro ao clonar mensagem:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Clonar multiplas mensagens de uma vez
app.post('/clone-multiple', async (req, res) => {
    try {
        const { messageIds } = req.body;

        if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({ success: false, error: 'messageIds e obrigatorio (array)' });
        }

        console.log('[CLONE] Clonando ' + messageIds.length + ' mensagens em lote...');

        const mensagens = messageIds.map(id => {
            const msg = capturedMessages.find(m => m.id === id);
            if (msg) {
                return {
                    mensagem: msg.text || '',
                    imagem_url: msg.imageUrl,
                    grupo_origem: msg.groupId,
                    grupo_origem_nome: msg.groupName
                };
            }
            return null;
        }).filter(m => m !== null);

        if (mensagens.length === 0) {
            return res.status(404).json({ success: false, error: 'Nenhuma mensagem encontrada' });
        }

        try {
            const flaskResponse = await axios.post(FLASK_API + '/whatsapp/clone-multiple', {
                mensagens: mensagens
            }, { timeout: 60000 });

            console.log('[CLONE] ' + flaskResponse.data.total_sucesso + ' mensagens clonadas!');

            res.json({
                success: true,
                message: flaskResponse.data.total_sucesso + ' mensagens clonadas e agendadas!',
                data: flaskResponse.data
            });

        } catch (flaskError) {
            console.error('[CLONE] Erro ao comunicar com Flask:', flaskError.message);
            res.status(500).json({
                success: false,
                error: 'Erro ao processar clonagem: ' + flaskError.message
            });
        }

    } catch (error) {
        console.error('[CLONE] Erro na clonagem em lote:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obter estatisticas da fila de clonagem
app.get('/clone-queue/stats', async (req, res) => {
    try {
        const flaskResponse = await axios.get(FLASK_API + '/fila-mensagens/estatisticas', { timeout: 5000 });
        res.json(flaskResponse.data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Listar fila de mensagens clonadas
app.get('/clone-queue', async (req, res) => {
    try {
        const status = req.query.status || 'todos';
        const flaskResponse = await axios.get(FLASK_API + '/fila-mensagens?status=' + status, { timeout: 10000 });
        res.json(flaskResponse.data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
