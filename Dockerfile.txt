# Use Node.js 18 with Debian base (includes apt-get)
FROM node:18-bullseye

# Install FFmpeg and other dependencies
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Create necessary directories
RUN mkdir -p uploads outputs temp

# Expose the port
EXPOSE 8080

# Verify FFmpeg installation (optional - for debugging)
RUN ffmpeg -version

# Start the application
CMD ["npm", "start"]
