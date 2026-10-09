import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { InMemoryScriptRepository } from "./repository.ts";

const port = Number(process.env.PORT ?? 3003);
const app = createApp({ repo: new InMemoryScriptRepository(), clock: systemClock });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`revisão de roteiro em http://127.0.0.1:${info.port}`);
});
