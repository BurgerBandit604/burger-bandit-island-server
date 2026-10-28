FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY racing ./racing
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
