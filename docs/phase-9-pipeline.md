# Phase 9: synchronous pipeline

`apps/api/scripts/generate.ts "<prompt>"` calls `generateVideo`, which plans a script through the LLM task router, synthesizes voice, fetches stock visuals, transcribes the narration into captions, assembles the shared schema-version-2 timeline, and renders an MP4. Use `--preview` for a fast 480-pixel-high render and `--out <path>` to choose the output. For local wiring checks set `LLM_PROVIDER=fake`, `TTS_PROVIDER=fake`, `STOCK_PROVIDER=fake`, and `TRANSCRIPTION_PROVIDER=fake`.

The voice, visual download, and caption tasks start together for each scene. Caption transcription waits for that scene's generated audio, as the transcript must match the final encoded narration. `onProgress(stage, percent)` reports stage progress. Each named step emits a JSON timing record; parallel scene durations are summed in the returned `timings` object. `editFromFootage` accepts already-ingested shared `Asset` records, plans valid source ranges through the `edit-agent` provider route, then renders the same timeline schema.

## Local fake run

Five distinct prompts were rendered with all providers fake, each to a 270×480 preview MP4 (portrait 9:16) with 3 scenes and a 9.1-second duration. The observed plan/fetch/voice/caption/assemble/render timings were respectively: 6–15 ms, 0.32–0.94 s, 1.1–2.6 s, 2.1–4.0 s, 18–21 ms, and 2.7–3.5 s. Voice/caption timings sum the parallel scene work; render timing is wall time.

| Prompt                               | What was poor in the fake output                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Kyoto bamboo forest morning walk     | LLM fake ignored the prompt and returned Tokyo nightlife; sample stock clip does not show bamboo. |
| Pour-over coffee guide               | Tokyo nightlife narration and generic repeated fixture footage do not explain coffee steps.       |
| Community marathon runner profile    | No runner visuals, no training progression, and narration remains the same Tokyo script.          |
| Mexico City street-food travel short | Visuals and narration do not match the requested city or food.                                    |
| Rooftop garden cooling explainer     | No garden or urban-heat explanation; fixed Tokyo nightlife plan and repeated fixture clip.        |

The fake is a wiring test, not a quality baseline: it returns a fixed script, a sample narration MP3, a sample video clip under distinct fixture IDs, and evenly spaced sample words. Real visual relevance and narration/caption alignment require a live planning provider, actual TTS, and Whisper.

## Provider substitutions exercised

- Pixabay alone with the other adapters fake: rendered a valid preview from cached/downloaded portrait stock.
- Docker Whisper alone with the other adapters fake: rendered a valid preview and generated timestamped words from each narration audio file.
- Pixabay plus Docker Whisper in one local integration render: rendered successfully as well.
- OpenCode planning after starting the configured local server: rendered a valid preview; planning took about 46 seconds.
- OpenAI TTS was attempted separately and returned `no API key is configured for openai-tts`; no user's key is present in the local key vault for this provider.

To enable the real TTS run, save an OpenAI TTS key for the authenticated user. The local OpenCode server is running for the remaining provider checks.
