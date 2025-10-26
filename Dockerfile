FROM node:18-bullseye

# install ffmpeg, ImageMagick and fonts support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    libass9 \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

# Refresh font cache (so custom fonts in /fonts are available)
RUN fc-cache -f -v || true

ENV PORT=8080
CMD ["node", "server.js"]
