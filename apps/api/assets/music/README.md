# Procedural music library

The `calm.mp3`, `uplifting.mp3`, and `dramatic.mp3` beds are generated locally
from simple synthesized tones by `pnpm --filter api media:music`. They are
original procedural recordings released under CC0-1.0 and tagged by mood in
`getMusicLibrary()` from `src/services/media-providers.ts`. The generator makes
30-second, low-volume beds with fades and requires FFmpeg.
