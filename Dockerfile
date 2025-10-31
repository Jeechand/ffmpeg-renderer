FROM node:18-bullseye

# install ffmpeg, ImageMagick and fonts support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    libass9 \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy package.json only (supports projects without package-lock.json)
COPY package.json ./

# install dependencies (production only)
RUN npm install --production

COPY . .

# Refresh font cache (so custom fonts in /fonts are available)
# after COPY . .
COPY fonts /app/fonts
RUN fc-cache -f -v || true

ENV PORT=8080
CMD ["node", "server.js"]
