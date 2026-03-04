FROM node:20-slim

WORKDIR /app

COPY package*.json ./
# Sin playwright ya - mucho más ligero
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
