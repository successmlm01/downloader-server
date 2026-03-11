FROM node:18-slim

# Install Python, pip, ffmpeg, and yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (--break-system-packages required on newer Debian/Ubuntu)
RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Railway reads this to know which port to expose
EXPOSE 8080

CMD ["node", "server.js"]
