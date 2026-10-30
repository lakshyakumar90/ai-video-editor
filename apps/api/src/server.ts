import { app } from "./app.js";
import { env } from "./config/env.js";
import { authReady } from "./services/auth.js";
import { resumePendingMediaJobs } from "./services/media-ingestion.js";
import { logger } from "./lib/logger.js";

const port = env.PORT;
void authReady.then(resumePendingMediaJobs).catch((error: unknown) => {
  logger.error({ err: error }, "could not resume media ingestion jobs");
});
app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
