FROM node:latest
# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .

# Expose metrics port
EXPOSE 9090

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Run the Prometheus exporter
CMD ["node", "main-prometheus-modular.js"]