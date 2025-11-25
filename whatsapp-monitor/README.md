# WhatsApp Monitor Server

Servidor Node.js com Baileys para monitoramento de grupos do WhatsApp.

## Instalação

```bash
npm install
```

## Uso

```bash
npm start
```

O servidor será iniciado na porta **3001**.

## API Endpoints

### Status
- `GET /status` - Retorna status da conexão

### QR Code
- `GET /qr` - Retorna QR Code para autenticação

### Grupos
- `GET /groups` - Lista todos os grupos disponíveis
- `POST /groups/monitor` - Adiciona grupo ao monitoramento
  ```json
  {
    "groupId": "123456789@g.us"
  }
  ```
- `DELETE /groups/monitor/:groupId` - Remove grupo do monitoramento

### Configurações de Afiliado
- `GET /affiliate/settings` - Lista configurações
- `POST /affiliate/settings` - Salva configuração
  ```json
  {
    "platform": "mercadolivre",
    "affiliateLink": "seu-link-de-afiliado"
  }
  ```
- `DELETE /affiliate/settings/:platform` - Remove configuração

### Logout
- `POST /logout` - Desconecta do WhatsApp

## Configuração

Crie um arquivo `.env` (opcional):

```env
PORT=3001
FLASK_API=http://localhost:5000
```

## Arquivos Gerados

- `auth_info_baileys/` - Sessão do WhatsApp (não compartilhar!)
- `config.json` - Configurações de grupos e afiliados

## Integração com Flask

O servidor se comunica com a API Flask na porta 5000 para processar produtos.

Endpoint usado:
- `POST /webhook/processar` - Processa produto e retorna mensagem formatada

## Plataformas Suportadas

- Mercado Livre
- Amazon
- Shopee
- Magazine Luiza
- Americanas
- AliExpress

## Logs

Os logs são exibidos no console em tempo real.

## Segurança

- Não compartilhe a pasta `auth_info_baileys/`
- Não compartilhe o arquivo `config.json`
- Esses arquivos já estão no `.gitignore`
