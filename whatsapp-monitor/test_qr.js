// Script de teste para diagnosticar problema do QR Code

const QRCode = require('qrcode');

// Teste 1: Gerar QR Code simples
const testData = 'teste123456789';

console.log('🧪 Teste de Geração de QR Code\n');

console.log('1️⃣ Testando geração de QR Code...');
QRCode.toDataURL(testData)
    .then(url => {
        console.log('✅ QR Code gerado com sucesso!');
        console.log(`   Tamanho: ${url.length} caracteres`);
        console.log(`   Tipo: ${url.substring(0, 30)}...`);
    })
    .catch(err => {
        console.error('❌ Erro ao gerar QR Code:', err);
    });

// Teste 2: Simular QR do WhatsApp
const fakeWhatsAppQR = '2@abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';

console.log('\n2️⃣ Testando QR Code simulado do WhatsApp...');
QRCode.toDataURL(fakeWhatsAppQR)
    .then(url => {
        console.log('✅ QR Code simulado gerado com sucesso!');
        console.log(`   Tamanho: ${url.length} caracteres`);
    })
    .catch(err => {
        console.error('❌ Erro:', err);
    });

// Teste 3: Verificar NodeCache
console.log('\n3️⃣ Testando NodeCache...');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 });

cache.set('test', 'valor-teste');
const valor = cache.get('test');

if (valor === 'valor-teste') {
    console.log('✅ NodeCache funcionando corretamente');
} else {
    console.error('❌ NodeCache com problema');
}

console.log('\n✅ Todos os testes concluídos!');
