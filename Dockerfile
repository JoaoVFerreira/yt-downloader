# Build stage
FROM node:18-slim as builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:18-slim

# Instalar dependências do sistema em uma única camada
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Instalar yt-dlp usando --break-system-packages (seguro em container)
RUN python3 -m pip install --no-cache-dir --break-system-packages yt-dlp

# Verificar instalações
RUN python3 --version && \
    python3 -m pip --version && \
    python3 -m yt_dlp --version

# Configurar usuário não-root
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --gid 1001 nodejs

WORKDIR /app

# Copiar node_modules do build stage
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copiar código da aplicação
COPY --chown=nodejs:nodejs . .

# Criar diretórios necessários
RUN mkdir -p downloads logs && \
    chown -R nodejs:nodejs downloads logs

# Mudar para usuário não-root
USER nodejs

# Expor porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Comando de inicialização
CMD ["npm", "start"]