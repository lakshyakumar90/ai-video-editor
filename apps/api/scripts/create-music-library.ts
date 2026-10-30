import "dotenv/config";
import {
  ensureProceduralMusicLibrary,
  getMusicLibrary,
} from "../src/services/media-providers.js";

await ensureProceduralMusicLibrary();
console.log(JSON.stringify(getMusicLibrary(), null, 2));
