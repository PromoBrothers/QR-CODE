FROM node:18-slim

WORKDIR /app

# Copiar package.json
COPY package*.json ./

# Instalar dependências
RUN npm install

# Copiar código
COPY . .

# Expor porta
EXPOSE 3001

# Rodar servidor
CMD ["npm", "start"]
