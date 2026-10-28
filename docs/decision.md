# Decision Record: Local TTS, Speech-to-Text, and Stock Media

**Status:** Proposed\
**Date:** 2026-10-27\
**Scope:** Media-generation features for the existing monorepo\
**Primary constraint:** No per-request AI API fees for text-to-speech or
speech-to-text; run inference locally on the developer's Windows PC.
Pexels is the selected external stock-media provider and uses its free
API key.

------------------------------------------------------------------------

## 1. Context

The application uses a monorepo with this structure:

``` text
/
├── apps/
│   ├── web/                  # Frontend application
│   └── api/                  # Node.js backend/API
├── packages/                 # Shared packages used across apps/services
└── decision.md               # This decision record
```

The current development machine has:

-   Windows
-   Intel Core i5 CPU
-   16 GB RAM
-   No dedicated GPU

The solution should work on CPU, keep model inference out of the
browser, minimize setup and operational complexity, and avoid paid AI
API calls. Internet access is required initially to download models and
dependencies. Once downloaded and cached, local TTS/STT inference should
be able to work offline.

> **Repository note:** The requested structure was described as
> `app/web`, `app/api`, and `packages`. This document uses `apps/web`
> and `apps/api` as shown in the examples above only as a convention.
> Adjust the directory names to match the repository's actual paths; do
> not rename existing directories just to match this document.

## 2. Decisions at a glance

  -----------------------------------------------------------------------
  Capability        Decision          Where it runs     External API key
  ----------------- ----------------- ----------------- -----------------
  Text-to-speech    Kokoro-82M ONNX,  Node.js API       No
  (TTS)             using `kokoro-js` process           
                    with CPU                            
                    inference                           

  TTS fallback      Piper, if Kokoro  Local process /   No
                    latency,          executable        
                    compatibility, or                   
                    memory use is                       
                    unsuitable                          

  Speech-to-text    `whisper.cpp`     Local executable  No
  (STT)             with the `base`   invoked by        
                    model for         Node.js           
                    multilingual                        
                    audio, or                           
                    `base.en` for                       
                    English-only                        
                    audio                               

  Stock photos and  Pexels API        Node.js API       Yes --- free
  videos                              process makes     Pexels API key
                                      outbound requests 

  Shared            Shared package    Imported by web   No
  contracts/types   under `packages/` and API           

  Media processing  FFmpeg            Local executable  No
  (optional)                          invoked by        
                                      Node.js           
  -----------------------------------------------------------------------

**Important terminology:** Whisper is the speech-recognition
model/family. `whisper.cpp` is a C/C++ implementation that runs Whisper
models locally. This decision selects `whisper.cpp` as the initial STT
runtime, rather than a hosted transcription API.

## 3. TTS decision: Kokoro-82M

### Why

-   Small model relative to many modern speech-generation models.
-   Can run locally through ONNX Runtime using the JavaScript
    `kokoro-js` package.
-   Does not require a paid hosted inference API.
-   Can be loaded once and reused for multiple requests.

### Initial implementation

Install in the Node.js API workspace, using the package manager already
adopted by the monorepo:

``` bash
npm install kokoro-js
```

Use the official Kokoro JavaScript implementation and its documented
model ID, voice names, options, and output format. A typical setup uses
the ONNX model `onnx-community/Kokoro-82M-v1.0-ONNX` and a quantized
`q8` model on CPU where supported. Verify the exact options against the
installed package version.

Illustrative script (adapt to the installed package version):

``` js
import { KokoroTTS } from "kokoro-js";

const tts = await KokoroTTS.from_pretrained(
  "onnx-community/Kokoro-82M-v1.0-ONNX",
  {
    dtype: "q8",
    device: "cpu",
  }
);

const audio = await tts.generate(
  "Hello. This is locally generated speech.",
  { voice: "af_heart" }
);

audio.save("./speech.wav");
```

Treat this as a smoke-test example, not a guarantee that every package
version exposes exactly the same options. Confirm the package README and
TypeScript types if an option or method differs.

### Runtime requirements and behavior

-   Load the model once when the API service starts, or initialize it
    lazily on the first TTS request.
-   Do not download or initialize the model on every request.
-   Expose TTS through a backend endpoint such as `POST /api/tts`.
-   Accept validated text and optional supported voice settings.
-   Return WAV audio (or another explicitly supported format).
-   Add input-length limits, request timeouts, and a concurrency limit
    to avoid exhausting CPU/RAM.
-   Cache generated output only if appropriate for the product and
    privacy requirements.
-   Keep model/cache paths configurable through environment variables
    where supported.

### Fallback: Piper

Use Piper if Kokoro does not meet performance, compatibility, or
deployment needs. Piper is a separate local TTS engine with downloadable
voice models. Select a maintained implementation and verify its current
installation instructions and each voice model's license before shipping
it.

Do not implement both engines initially unless testing demonstrates a
need. Kokoro is the primary decision; Piper is a fallback.

## 4. STT decision: whisper.cpp

### Why

-   Runs Whisper models locally with CPU support.
-   Does not require a hosted transcription API or API key.
-   Can be called from Node.js using `node:child_process`.
-   Provides a simple separation between the Node API and the native
    inference runtime.

### Model selection

  -----------------------------------------------------------------------
  Model                   Use case                Trade-off
  ----------------------- ----------------------- -----------------------
  `base.en`               English-only input      Smaller and focused on
                                                  English

  `base`                  Hindi, English, and     Multilingual; may be
                          other supported         slower or less accurate
                          languages               than a larger model in
                                                  difficult conditions

  `tiny` / `tiny.en`      Very constrained        Faster/smaller, but
                          performance needs or    generally less accurate
                          quick smoke tests       
  -----------------------------------------------------------------------

Start with **`base`** if the product needs both Hindi and English. Use
**`base.en`** only if the feature is explicitly English-only. Benchmark
`tiny` if the i5's speed is insufficient.

### Installation on Windows

1.  Follow the official `whisper.cpp` repository's Windows instructions
    or download a suitable official release binary if available.

2.  Keep the executable and model in a stable local directory, for
    example:

    ``` text
    C:\local-ai\whisper\
    ├── whisper-cli.exe
    └── models\
        └── ggml-base.bin
    ```

3.  Download the matching model from the official `whisper.cpp` model
    repository. Use `ggml-base.bin` for multilingual audio or
    `ggml-base.en.bin` for English-only audio.

4.  Test the command outside the application first:

    ``` powershell
    & "C:\local-ai\whisper\whisper-cli.exe" `
      -m "C:\local-ai\whisper\models\ggml-base.bin" `
      -f "C:\local-ai\sample.wav" `
      -nt
    ```

    Update paths to match the actual installation. The input must be a
    supported audio file; use a WAV file for the initial smoke test.

### Node.js integration

Use `node:child_process` (`spawn`, not shell string concatenation) to
run the executable. Configure the executable and model paths using
environment variables, for example:

``` dotenv
WHISPER_CPP_PATH=C:\local-ai\whisper\whisper-cli.exe
WHISPER_MODEL_PATH=C:\local-ai\whisper\models\ggml-base.bin
```

On Windows, ensure paths are handled correctly by the environment-file
parser and path library. Do not expose arbitrary server file paths to
the caller.

The API should accept an uploaded audio file, store it in a controlled
temporary directory, run `whisper.cpp`, return the transcript, and
delete temporary files in a `finally` cleanup path. Capture stdout and
stderr, enforce a timeout, handle non-zero exit codes, and cap
concurrent transcription jobs.

### Audio upload and safety requirements

-   Validate file type, size, and duration.
-   Use generated temporary filenames rather than user-supplied paths.
-   Never accept an arbitrary local filesystem path from an untrusted
    client.
-   Store uploads outside publicly served directories.
-   Delete temporary audio after processing unless the product
    explicitly requires retention.
-   Add rate limits and concurrency limits.
-   Avoid logging audio content or full transcripts unless necessary and
    disclosed.

## 5. Pexels stock-media decision

Pexels remains the selected source for stock photos and videos, using
its free API key.

### Integration

-   Store the key only in the API service's environment,
    e.g. `PEXELS_API_KEY`.
-   Never put the key in frontend environment variables or ship it in
    the web bundle.
-   Add API routes such as
    `GET /api/media/search?query=mountains&type=video`.
-   The Node API calls the Pexels API, validates query parameters, and
    returns a reduced response containing only fields the frontend
    needs.
-   Handle rate limits, errors, and empty search results gracefully.
-   Cache metadata and results where permitted by Pexels' current terms
    and API rules.
-   Do not assume that stock assets are permanently available or that
    every use is permitted; check the applicable Pexels license and API
    terms, especially for redistribution, sensitive uses, and any
    product-specific restrictions.
-   Do not download or permanently mirror assets unless the current
    terms permit the intended use.

Example environment variable:

``` dotenv
PEXELS_API_KEY=replace_with_your_key
```

The placeholder above is documentation only. Do not commit the actual
key. Add `.env` files to `.gitignore`, and use the deployment platform's
secret manager for production.

### Offline behavior

Pexels is an external service, so searching for new assets requires an
internet connection. Local TTS and STT can run offline after the
relevant models and dependencies have been downloaded. If offline media
access is required, create a separate, curated local asset library with
recorded source and license metadata.

## 6. Monorepo boundaries

Keep the current monorepo structure and use the actual package manager
and workspace configuration already present.

``` text
apps/
├── web/                         # React/Vite or existing frontend
└── api/                         # Node.js API
    ├── src/
    │   ├── routes/
    │   │   ├── tts.*
    │   │   ├── transcription.*
    │   │   └── media.*
    │   ├── services/
    │   │   ├── tts.*
    │   │   ├── transcription.*
    │   │   └── pexels.*
    │   └── config/
packages/
└── shared/                      # Or the existing shared package
    ├── src/
    │   ├── contracts/
    │   └── schemas/
    └── package.json
```

This is a suggested logical layout, not a requirement to create
duplicate packages or rename current files.

### Frontend (`web`)

-   Calls the API using the existing API client.
-   Uploads audio through a multipart/form-data request.
-   Displays transcription results and TTS playback.
-   Searches stock media through the backend.
-   Never imports local model files or holds the Pexels API key.

### Backend (`api`)

-   Owns model initialization, local inference, subprocess execution,
    file handling, and Pexels requests.
-   Exposes stable HTTP endpoints and validates all inputs.
-   Manages concurrency and cleanup.
-   Does not assume that the API is accessible only to a trusted local
    user if it is exposed to a network.

### Shared package (`packages`)

Share only runtime-independent contracts and validation schemas, such
as:

-   `TtsRequest` / `TtsResponse`
-   `TranscriptionResponse`
-   `MediaSearchRequest` / `MediaSearchResponse`
-   Common error response types

Do not put model binaries, executable paths, secret keys, or Node-only
inference code in a shared package imported by the browser. If the
shared package is consumed by both web and API, ensure its exports are
browser-safe.

## 7. Suggested API contract

Use the project's existing route conventions and prefixes. These are
conceptual endpoint examples:

  ------------------------------------------------------------------------
  Endpoint                 Method                  Purpose
  ------------------------ ----------------------- -----------------------
  `/api/tts`               `POST`                  Generate speech from
                                                   validated text

  `/api/transcription`     `POST`                  Upload audio and return
                                                   transcript

  `/api/media/search`      `GET`                   Search Pexels for
                                                   photos or videos

  `/api/health/local-ai`   `GET`                   Report whether local
                                                   model/runtime
                                                   dependencies are ready
  ------------------------------------------------------------------------

Possible contracts:

``` ts
type TtsRequest = {
  text: string;
  voice?: string;
};

type TranscriptionResponse = {
  text: string;
  language?: string;
};

type MediaSearchRequest = {
  query: string;
  type: "photo" | "video";
  page?: number;
  perPage?: number;
};
```

The contracts are examples. Align them with the existing validation
library, naming conventions, authentication, and API response envelope.
Do not expose local paths in responses.

## 8. Configuration

Keep environment-specific settings in the API's local environment file
and production secret configuration.

``` dotenv
# Pexels: external stock-media API
PEXELS_API_KEY=

# Local speech-to-text runtime
WHISPER_CPP_PATH=C:\local-ai\whisper\whisper-cli.exe
WHISPER_MODEL_PATH=C:\local-ai\whisper\models\ggml-base.bin

# Optional: configure a cache directory if supported by the chosen runtime
# LOCAL_AI_CACHE_DIR=
```

Kokoro's exact model-cache configuration depends on the package and
model loader version. Use the documented cache configuration instead of
assuming an environment variable name. Never put secrets in
`packages/shared` or frontend-exposed variables.

## 9. Performance plan for 16 GB RAM / Intel i5 / no dedicated GPU

-   Start with Kokoro quantized CPU inference and Whisper
    `base`/`base.en`.
-   Load Kokoro once and reuse the instance.
-   Run only a small number of inference jobs concurrently; begin with
    one STT job and one TTS job at a time.
-   Measure startup time, time-to-first-audio, real-time factor for
    transcription, peak memory, and API responsiveness.
-   If STT is too slow, benchmark `tiny` before considering a larger
    model or hardware change.
-   If TTS is too slow, compare Kokoro and Piper using representative
    scripts and the voices needed by the product.
-   Do not assume the machine will provide real-time performance for all
    audio lengths. Test with actual target workloads.

## 10. Licensing and operational checks

Before release:

1.  Verify the licenses of Kokoro code, the exact model files, the
    selected voice, and all dependencies.
2.  Verify the license of the selected Piper implementation and each
    Piper voice if the fallback is used.
3.  Verify the `whisper.cpp` code and model terms for the intended
    commercial or non-commercial use.
4.  Review the current Pexels API terms, rate limits, attribution
    expectations, and content restrictions.
5.  Keep attribution/source metadata when required or useful.
6.  Document that local inference uses the machine's CPU, memory, and
    disk.
7.  Do not claim the entire application is offline: Pexels search still
    requires network access.
8.  Do not commit model binaries, generated audio, downloaded media,
    `.env` files, or API keys to source control unless there is a
    specific, reviewed reason.

## 11. Implementation sequence

1.  **Verify the repository:** inspect workspace scripts, package
    manager, Node version, module format, API framework, and shared
    package conventions.
2.  **Prove STT works independently:** install `whisper.cpp`, download
    `base` or `base.en`, and transcribe a sample WAV from PowerShell.
3.  **Prove TTS works independently:** install `kokoro-js`, download the
    model, and generate a WAV from a Node script.
4.  **Add API services:** wrap each local engine with typed functions
    and explicit errors.
5.  **Add routes and validation:** upload limits, text limits, timeouts,
    cleanup, and concurrency controls.
6.  **Add Pexels integration:** key on the server only, validated query
    parameters, normalized results, and sensible error handling.
7.  **Add shared contracts:** keep shared exports safe for both browser
    and server.
8.  **Connect the frontend:** loading states, progress/error UI, audio
    playback, transcription output, and media search.
9.  **Test offline:** after models are cached, disconnect the network
    and verify TTS/STT still work. Separately verify that Pexels search
    fails gracefully offline.
10. **Benchmark and review licenses:** record real performance on the
    target PC before finalizing model choices.

## 12. Consequences and trade-offs

### Benefits

-   No per-request hosted TTS or STT charges.
-   Audio and transcription can remain on the local machine.
-   Keeps the existing Node.js backend and monorepo architecture.
-   Pexels API key is protected by the backend.
-   Models can be swapped behind stable service interfaces.

### Costs and limitations

-   The first model download requires internet and disk space.
-   CPU inference may be slower than cloud GPUs.
-   Native executables and model paths require platform-aware
    configuration.
-   Local inference consumes the host machine's CPU and RAM.
-   Pexels remains an external dependency for stock-media search.
-   A local backend does not automatically provide inference to remote
    users. A deployed server needs compatible compute, model files, and
    sufficient resources; the developer's local machine will not serve
    production users unless deliberately configured to do so.

------------------------------------------------------------------------

## Final decision

Use **Kokoro-82M through `kokoro-js` for local TTS**, **`whisper.cpp`
with the multilingual `base` model for local STT** (or `base.en` if
input is English-only), and **Pexels' free API through the Node.js
backend** for stock photos and videos. Keep shared types and validation
in the existing shared package. Use Piper only as a tested fallback, not
as a second mandatory engine.

This is the initial implementation decision. Revisit model selection
only after measuring quality, latency, memory usage, and licensing on
the target machine.

------------------------------------------------------------------------

## Appendix: OpenCode terms check (checked 2026-10-28)

Result of reviewing **https://opencode.ai/legal/terms-of-service**
(OpenCode / Anomaly Innovations, Inc., effective 2026-08-15), the model
docs (**https://opencode.ai/v2/docs/console/models/**) and the free-model
notes, against the intended use: the API backend drives a local OpenCode
server (HTTP + SDK, `opencode serve`) as its swappable `LlmProvider`,
sending prompts to the free ("opencode" provider) models and parsing the
JSON output.

### Compliant for the current use

-   Access path is sanctioned: "Free-tier chat models require OpenCode;
    use paid models or Go from other clients." We consume free models
    *through OpenCode itself* (its own server + first-party client SDK),
    not by calling upstream models from another client - exactly the
    supported pattern.
-   Output ownership: "you ... own the Output", assigned to us by the
    Terms; generated scene scripts are ours to use.
-   Paid terms do not apply: free models carry no charge today. The
    Terms promise notice before any free service becomes paid.
-   We use a single account/password (no multi-account limit evasion,
    no bulk "data extraction", no scraping of web pages, no use of
    Output to train competing models, no representing Output as
    human-written in third-party contexts).

### Constraints and cautions to respect

1.  **"Internal use only" clause** - "You will only use the Services for
    your own internal use, and not on behalf of ... any third party."
    Using the free tier inside this project is fine for development and
    self-use; **exposing OpenCode free models as a hosted backend for
    external users later would need the paid/OpenCode Go route or direct
    provider APIs**, not the free tier.
2.  **Programmatic-output clause** - restriction 5 prohibits
    "automatically or programmatically extract[s] data or Output".
    Consulted practical reading: the OpenCode server/API/SDK endpoints
    are the product's own interface for programmatic interaction, and
    the models docs explicitly route free-tier access through OpenCode;
    the clause targets bulk extraction/scraping of data from the
    Services bypassing OpenCode. Avoid bulk scripted harvesting; keep
    one-session-one-request, bounded load (as implemented).
3.  **Free models are time-limited and may collect feedback** - most
    free models are "free on OpenCode for a limited time" while the team
    "collect[s] feedback", i.e. prompts/completions from unpaid accounts
    may be used to improve services/models. Do not send personal data,
    secrets, or third-party copyrighted text in prompts on the free
    tier; keep prompts to synthetic scene briefs.
4.  **Per-model data policies differ** - GLM-5.3-Flash Free and
    DeepSeek V4.1 Flash Free: zero-retention, no training on data.
    Flint 40B Free, MiMo, Nemotron lineup, Big Pickle (stealth model):
    feedback/improvement use. Beam Free: no training, 30-day safety
    retention, and a country exclusion list (not available in CN/RU/KP
    etc.). Keep the preference order configurable
    (`OPENCODE_MODEL_PREFERENCE`) so any model can be deprioritized or
    removed without code changes.
5.  **No availability guarantee** - free models rotate and can suspend
    or discontinue "any part of the Services"; the provider fallback
    chain and the typed `RateLimitError` are the mitigations.
6.  **Arbitration/US-legal framework** - standard ToS from a US company;
    noted, not an obstacle for internal development.

### Practical takeaways for this repo

-   Keep the free tier for local/self-use development and internal
    generation as planned in the Phase-3 checklist.
-   Never put user PII, credentials, or sensitive prompt content on the
    free tier (it may be used for service improvement).
-   If the feature ships to external users, revisit this section: the
    compliant option is OpenCode Go (subscription with included usage)
    or paid models/direct provider APIs behind the same
    `LlmProvider` interface.
