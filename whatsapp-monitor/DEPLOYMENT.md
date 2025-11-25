# Guia de Deployment - WhatsApp Monitor

## Opção 1: Docker Compose (Recomendado)

### Build e execução
```bash
docker-compose up -d
```

### Ver logs
```bash
docker-compose logs -f whatsapp-monitor
```

### Parar serviço
```bash
docker-compose down
```

### Rebuild após alterações
```bash
docker-compose up -d --build
```

## Opção 2: Docker Manual

### Build da imagem
```bash
docker build -t whatsapp-monitor .
```

### Executar container
```bash
docker run -d \
  --name whatsapp-monitor \
  -p 3001:3001 \
  -v $(pwd)/auth_info:/app/auth_info \
  -v $(pwd)/monitored_groups.json:/app/monitored_groups.json \
  -e FLASK_API=http://seu-servidor:5000 \
  --restart unless-stopped \
  whatsapp-monitor
```

### Ver logs
```bash
docker logs -f whatsapp-monitor
```

### Parar container
```bash
docker stop whatsapp-monitor
docker rm whatsapp-monitor
```

## Opção 3: Deploy em Servidor VPS

### 1. Enviar arquivos para o servidor
```bash
# Via git
git clone seu-repositorio
cd whatsapp-monitor

# Ou via SCP
scp -r . user@servidor:/caminho/whatsapp-monitor
```

### 2. No servidor, instalar Docker
```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Instalar Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 3. Configurar variáveis de ambiente
```bash
# Criar arquivo .env
cat > .env << EOF
FLASK_API=http://localhost:5000
PORT=3001
NODE_ENV=production
EOF
```

### 4. Iniciar serviço
```bash
docker-compose up -d
```

## Configurações Importantes

### Volumes persistentes
- `./auth_info` - Mantém sessão do WhatsApp
- `./monitored_groups.json` - Lista de grupos monitorados

### Portas
- 3001 - API WhatsApp Monitor
- 5000 - Flask API (configurar FLASK_API)

### Healthcheck
O container verifica automaticamente se o serviço está rodando na rota `/status`

## Troubleshooting

### Container não inicia
```bash
docker-compose logs whatsapp-monitor
```

### Resetar autenticação WhatsApp
```bash
docker-compose down
rm -rf auth_info/*
docker-compose up -d
```

### Ver QR Code
Acesse: `http://seu-servidor:3001/qr`

### Verificar status
```bash
curl http://localhost:3001/status
```

## Produção com Nginx

### Configuração Nginx reverso
```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Backup

### Fazer backup da autenticação
```bash
tar -czf whatsapp-backup-$(date +%Y%m%d).tar.gz auth_info monitored_groups.json
```

### Restaurar backup
```bash
tar -xzf whatsapp-backup-YYYYMMDD.tar.gz
docker-compose restart
```
