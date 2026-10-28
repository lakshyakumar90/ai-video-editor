import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs `ffmpeg` with an **args array** — never a shell string — so that
 * paths with spaces or special characters cannot break out of the
 * invocation. Captures stdout/stderr fully; rejects on spawn failure or
 * non-zero exit with the stderr tail for quick diagnosis.
 */
export function runFfmpeg(args: readonly string[]): Promise<ProcessResult> {
  return runProcess("ffmpeg", args);
}

/**
 * Runs `ffprobe` with an args array, same guarantees as {@link runFfmpeg}.
 */
export function runFfprobe(args: readonly string[]): Promise<ProcessResult> {
  return runProcess("ffprobe", args);
}

/**
 * Reads a media file's container duration in seconds via `ffprobe`.
 * Works for audio and video (MP3, WAV, MP4, ...).
 */
export async function probeDuration(file: string): Promise<number> {
  const result = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);

  let parsed: { format?: { duration?: unknown } };
  try {
    parsed = JSON.parse(result.stdout) as { format?: { duration?: unknown } };
  } catch (error) {
    throw new Error(
      `could not parse ffprobe output for "${file}": ${result.stdout.trim().slice(0, 200)}`,
      { cause: error },
    );
  }

  const duration = Number(parsed.format?.duration);
  if (parsed.format?.duration == null) {
    // e.g. images and some raw streams have no container duration
    throw new Error(`"ffprobe" reported no duration for "${file}"`);
  }
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(
      `"ffprobe" returned an invalid duration for "${file}": ${parsed.format?.duration}`,
    );
  }
  return duration;
}

/**
 * Spawns `command` with `args` (no shell), resolves with captured output
 * when the process exits 0, rejects otherwise.
 */
export function runProcess(
  command: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT"
          ? `(command "${command}" not found; it must be installed and on PATH)`
          : "";
      reject(new Error(`failed to start "${command}": ${error.message} ${hint}`, { cause: error }));
    });

    child.on("close", (code: number | null) => {
      const dec = (buffers: Buffer[]) =>
        Buffer.concat(buffers).toString("utf8");
      const stderrText = dec(stderr);

      if (code !== 0) {
        // ffmpeg writes its human-readable diagnostics to stderr
        reject(
          new Error(`"${command}" exited with code ${code}: ${stderrTail(stderrText)}`),
        );
        return;
      }

      resolve({ stdout: dec(stdout), stderr: stderrText });
    });
  });
}

/** Keeps the last ~2000 characters of stderr in error messages. */
function stderrTail(stderr: string): string {
  return stderr.length > 2000 ? `…${stderr.slice(-2000)}` : stderr;
}
