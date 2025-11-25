// Script de teste simplificado para WhatsApp
console.log('🧪 Iniciando teste de conexão...\n');

// Teste 1: Importar módulos
console.log('📦 Teste 1: Importando módulos...');
try {
    const baileys = require('@whiskeysockets/baileys');
    console.log('   ✅ Baileys importado com sucesso');

    const express = require('express');
    console.log('   ✅ Express importado com sucesso');

    const qrcode = require('qrcode');
    console.log('   ✅ QRCode importado com sucesso');

    console.log('\n✅ Todos os módulos foram importados!\n');
} catch (error) {
    console.error('❌ Erro ao importar módulos:', error.message);
    process.exit(1);
}

// Teste 2: Criar servidor básico
console.log('🌐 Teste 2: Criando servidor Express...');
try {
    const express = require('express');
    const app = express();
    const PORT = 3001;

    app.get('/test', (req, res) => {
        res.json({ message: 'Servidor funcionando!' });
    });

    const server = app.listen(PORT, () => {
        console.log(`   ✅ Servidor rodando na porta ${PORT}`);
        console.log(`   🌐 Teste em: http://qrcode:${PORT}/test\n`);

        // Teste 3: Configurar Baileys
        testBaileys();
    });
} catch (error) {
    console.error('❌ Erro ao criar servidor:', error.message);
    process.exit(1);
}

// Teste 3: Baileys
async function testBaileys() {
    console.log('📱 Teste 3: Configurando Baileys...');

    try {
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            fetchLatestBaileysVersion,
            DisconnectReason
        } = require('@whiskeysockets/baileys');

        console.log('   ✅ Funções do Baileys importadas');

        const { version } = await fetchLatestBaileysVersion();
        console.log(`   ✅ Versão do WhatsApp: ${version.join('.')}`);

        const { state, saveCreds } = await useMultiFileAuthState('test_auth');
        console.log('   ✅ Estado de autenticação carregado');

        console.log('\n🎉 TODOS OS TESTES PASSARAM!\n');
        console.log('📝 Próximos passos:');
        console.log('   1. O servidor está rodando em http://localhost:3001');
        console.log('   2. Teste acessando: http://localhost:3001/test');
        console.log('   3. Se funcionou, o problema não é com as dependências');
        console.log('   4. Pressione Ctrl+C para parar o teste\n');

    } catch (error) {
        console.error('\n❌ Erro ao configurar Baileys:', error.message);
        console.error('Stack completo:', error);
        process.exit(1);
    }
}
