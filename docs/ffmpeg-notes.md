# FFmpeg render spike notes

These commands were exercised on Windows with FFmpeg 7.0, including
`libx264`, `libass`, and AAC support. The Node wrapper calls `spawn` with an
argument array; keep filter graphs and paths as individual arguments rather
than building shell command strings.

## Run the spikes

From the repository root:

```powershell
pnpm --filter api exec tsx scripts/spike-image-audio-mp4.ts
pnpm --filter api exec tsx scripts/spike-clip-fits-audio.ts
pnpm --filter api exec tsx scripts/spike-scale-crop-1080x1920.ts
pnpm --filter api exec tsx scripts/spike-concat.ts
pnpm --filter api exec tsx scripts/spike-burn-ass.ts
pnpm --filter api exec tsx scripts/spike-ducked-mix.ts
pnpm --filter api exec tsx scripts/spike-three-scene-render.ts
```

The last command writes `tmp/outputs/three-scene-render.mp4`. The committed
fixtures are `tmp/samples/sample.png`, `sample-clip.mp4`, and `sample.mp3`.
The current fixture set has no separate music file, so the mix spikes use a
quiet synthesized chord as the music bed and the MP3 as narration.

## Working flags and filters

| Task                     | Working recipe                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Still + audio            | `-loop 1 -i still.png -i narration.mp3`, scale/pad, map both streams, encode H.264/AAC, and use `-shortest` so the still ends with audio.                                                                                                                   |
| Fit a clip to audio      | `-stream_loop -1 -i clip.mp4` when needed; encode video when looping, map the narration, and use `-shortest`. A longer clip can be trimmed with `-shortest`; stream copy is fine for that case.                                                             |
| Portrait crop            | `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1`; then encode with `-pix_fmt yuv420p`. This fills the frame without stretching.                                                                                               |
| Concatenate three scenes | Normalize each segment to identical H.264 geometry, pixel format, frame rate, and time base; write an ffconcat list and use `-f concat -safe 0 -i scenes.txt -c:v copy`.                                                                                    |
| Burn ASS subtitles       | Use `-vf "ass=filename='C\:/path/captions.ass'"`. On Windows, change backslashes to forward slashes and escape the drive colon as `C\:`. The ASS filter works as a separate `-vf` argument.                                                                 |
| Duck music under speech  | `[music][voice-detector]sidechaincompress=threshold=0.015:ratio=8:attack=15:release=300[ducked]`, then `[ducked][voice]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`. Split the voice with `asplit=2` for detector and audible voice. |

For a still with no crop, the 16:9 proof also uses
`scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1`.

The final script creates three short portrait segments from the still and two
parts of the clip, concatenates them, burns one caption per scene, then mixes
the MP3 with a sidechain-ducked chord bed. It probes the resulting duration,
dimensions, and audio stream. The sample narration is about three seconds, so
this is a short sync and orientation proof rather than a finished-length video.
The ducking spike uses a 440 Hz speech stand-in to compare the music-only RMS
before, during, and after speech; the measured music level fell by 17.5 dB
during speech on this run.

## Playback check

The output has been inspected with `ffprobe` for a 1080×1920 video stream, an
audio stream, and duration close to the narration. Phone playback remains a
manual device check; verify portrait orientation and perceived audio sync on a
phone before treating that checklist item as complete.
