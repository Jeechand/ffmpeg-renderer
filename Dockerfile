# Use the Debian-based Node image
FROM node:18-bullseye

# Install ffmpeg, ImageMagick, and font support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    libass9 \
    fontconfig \
    fonts-dejavu-core \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy package.json only to leverage Docker layer caching
COPY package.json ./

# install dependencies (production only)
RUN npm install --production

# copy app source
COPY . .

# copy your fonts directory (may contain subfolders like fonts/Lexend, fonts/Cormorant_Garamond)
COPY fonts /app/fonts

# Find all .ttf/.otf in /app/fonts (including subfolders) and copy them into the system fonts folder.
# Then rebuild the font cache so ImageMagick/ffmpeg (via fontconfig) can see them.
RUN mkdir -p /usr/local/share/fonts/custom && \
    find /app/fonts -type f \( -iname "*.ttf" -o -iname "*.otf" \) -exec cp {} /usr/local/share/fonts/custom/ \; && \
    fc-cache -f -v || true

# Environment & startup
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
