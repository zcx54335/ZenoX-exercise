FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY data ./data
COPY uploads ./uploads

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
