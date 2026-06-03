FROM denoland/deno:2.4.5

WORKDIR /app

COPY deno.json main.js logic.js ./

RUN deno cache --unstable-kv main.js

ENV PORT=8000
ENV DENO_KV_PATH=/data/hermes-lite.kv

VOLUME ["/data"]

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--allow-read=/data", "--allow-write=/data", "--unstable-kv", "main.js"]
