FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Grant write permissions for media uploads
RUN mkdir -p public/uploads && chmod -R 777 public/uploads

EXPOSE 7860

CMD ["node", "server.js"]