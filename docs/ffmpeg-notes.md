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
pnpm --filter api exec tsx scripts/spike-media-operations.ts
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

## Five-minute edit-operation spike

Run `pnpm --filter api exec tsx scripts/spike-media-operations.ts` to recreate
the benchmark and repeat the measurements. It loops the checked-in
1280×720 sample clip into a 300-second VFR file and adds a synthetic 440 Hz
audio track with six regular silent ranges. Outputs and raw timings are written
to ignored `tmp/outputs/ffmpeg-spikes/`; the process uses FFmpeg 7.0 on this
Windows workstation. Wall times include process start-up and vary with machine
and cache state.

| Operation                                    |                   Time | Result from the 300s source                                                            |
| -------------------------------------------- | ---------------------: | -------------------------------------------------------------------------------------- |
| Create VFR benchmark                         |                40.372s | 144.43 MB; 1280×720; average 18 fps; audio 48 kHz                                      |
| Frame-accurate 20s trim, re-encode           |                 8.974s | 20.000s; 4.85 MB                                                                       |
| Fast 20s trim, stream copy                   |                 0.234s | 20.013s; 10.28 MB; starts at the 70.000s keyframe for requested 71.237s (1.237s early) |
| VFR → CFR 30 fps and audio resample          |                34.799s | 300.01s; 30 fps; audio 48 kHz; 156.70 MB                                               |
| 480p proxy encode                            |                23.985s | 67.58 MB, 53.2% smaller; five random seeks 1.081s vs 1.141s original                   |
| Extract audio as 48 kHz PCM                  |                 0.895s | Full-length WAV                                                                        |
| Ten thumbnails, one every 30s                |                 5.971s | 320px-wide JPEGs                                                                       |
| Waveform image                               |                 0.980s | 1600×260 PNG                                                                           |
| Detect six silences                          |                 1.135s | `silencedetect` ranges parsed from stderr                                              |
| Remove silence with paired video/audio trims |                22.754s | 250.04s retained; video 249.920s, audio 250.041s (121ms end drift)                     |
| Movable 9:16 crop, left / center / right     | 1.761 / 1.694 / 1.853s | Each output 1080×1920, 8s                                                              |
| 1.25× video speed + `atempo` + `loudnorm`    |                34.206s | 240.00s; audio 48 kHz; loudnorm target -16 LUFS / -1.5 dBTP                            |

Use re-encoding when a cut must begin on the requested frame; the tested
stream-copy cut is about 38× faster but starts at the preceding keyframe, so
it fits rough assembly and fast previews. The 480p proxy cuts storage by about
half, while the measured five-seek difference was only 60ms and is within
start-up/cache noise; treat the proxy as a bandwidth and decode-load aid, not
a proven seek-speed win. CFR normalization gives downstream operations a
predictable clock and costs an additional encode pass. The silence-removal
filter applies matching time ranges to video and audio; its final streams
differ by 121ms due to frame and audio packet boundaries.

The hardcoded three-scene proof is reproducible with
`pnpm --filter api exec tsx scripts/spike-three-scene-render.ts`. It produced
three 1080×1920 scenes, 3.030s narration, a ducked synthesized music bed, and
burned ASS subtitles in a 3.000s MP4. The checked-in samples contain no
separate music track, so the current music bed is a generated chord.
