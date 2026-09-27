FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY widget.html ./
COPY course-widget.html ./

RUN mkdir -p /data
VOLUME /data
ENV DB_PATH=/data/tutor.db

EXPOSE 3001
CMD ["node", "server.js"]
