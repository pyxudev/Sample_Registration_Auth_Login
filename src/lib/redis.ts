import { createClient } from "redis";

const client = createClient({
  url: process.env.REDIS_URL,
});

client.on("error", (err) => {
  console.error("Redis error", err);
});

if (!client.isOpen) {
  client.connect().catch((err) => {
    console.error("Redis connect error", err);
  });
}

export { client as redis };
