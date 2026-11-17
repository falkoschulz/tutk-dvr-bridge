FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY native ./native
RUN test -f native/libIOTCAPIs_ALL.so -a -f native/include/IOTCAPIs.h -a -f native/include/AVAPIs.h || { \
      echo "ERROR: Missing proprietary TUTK SDK files in native/ (see README.md)."; \
      exit 1; \
    } && \
    npm run build && \
    gcc -O2 -Wall -Inative/include native/tutk_helper.c \
      -Lnative -l:libIOTCAPIs_ALL.so -lpthread -Wl,-rpath,'$ORIGIN' \
      -o native/tutk_helper

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/native/tutk_helper /app/native/libIOTCAPIs_ALL.so ./native/
ENV PORT=3001
ENV DVR_UID=""
ENV DVR_USER=admin
ENV DVR_PASS=""
ENV DVR_CHANNELS=8
ENV RTSP_HOST=""
EXPOSE 3001
CMD ["node", "dist/server.js"]
