FROM node:18

# Instalar Python e pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Instalar yt-dlp
RUN python3 -m pip install yt-dlp

WORKDIR /app

# Copiar package files
COPY package*.json ./
RUN npm install

# Copiar código
COPY . .

EXPOSE 3000

CMD ["npm", "start"]