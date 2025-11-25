# Usar imagem Node.js LTS slim para reduzir tamanho
FROM node:18-slim

# Instalar dependências do sistema necessárias para o Baileys
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Definir diretório de trabalho
WORKDIR /app

# Copiar arquivos de dependências do whatsapp-monitor
COPY whatsapp-monitor/package*.json ./

# Instalar apenas dependências de produção
RUN npm ci --only=production && \
    npm cache clean --force

# Copiar código da aplicação
COPY whatsapp-monitor/ ./

# Criar diretório para auth state
RUN mkdir -p auth_info

# Definir variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=3001
ENV FLASK_API=http://qrcode:5000

# Expor porta
EXPOSE 3001

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/status || exit 1

# Rodar servidor
CMD ["node", "server.js"]
