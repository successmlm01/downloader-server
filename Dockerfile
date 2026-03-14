FROM node:18-slim

# Install Python, pip, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp + curl_cffi (needed for TikTok/Facebook impersonation)
RUN pip3 install --break-system-packages yt-dlp curl_cffi

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
