// Why: jcode runs one server/client daemon per runtime dir (the daemon lock,
// socket, and debug socket all live there). Orca stamps a per-pane runtime dir
// so every Orca-launched jcode pane gets its own daemon, and jcode's lifecycle
// hooks (which fire inside the daemon) inherit that pane's ORCA_PANE_KEY
// instead of the first pane's. Without this, a second jcode pane connects the
// first pane's daemon and its status is attributed to the wrong tab.
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const JCODE_RUNTIME_DIR_ENV_KEY = 'JCODE_RUNTIME_DIR'

// Why: the socket file is `<runtimeDir>/jcode.sock`, and unix socket paths are
// capped at SUN_LEN (104 bytes). TMPDIR alone can be ~50 chars, so the full
// pane key (73 chars) never fits; a deterministic 16-hex hash keeps the path
// short while staying per-pane unique and stable across restarts.
export function buildJcodeRuntimeDir(paneKey: string): string {
  const hash = createHash('sha256').update(paneKey).digest('hex').slice(0, 16)
  return join(tmpdir(), 'orca-jcode', hash)
}

/** jcode's daemon model is unix-socket based; Windows support is unverified. */
export function shouldInjectJcodeRuntimeDir(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

/** The per-pane jcode runtime-dir env value, or undefined on unsupported platforms. */
export function buildJcodeRuntimeDirEnv(
  paneKey: string,
  platform: NodeJS.Platform = process.platform
): Record<string, string> | undefined {
  return shouldInjectJcodeRuntimeDir(platform)
    ? { [JCODE_RUNTIME_DIR_ENV_KEY]: buildJcodeRuntimeDir(paneKey) }
    : undefined
}

/**
 * Ensures the per-pane jcode runtime dir exists before a PTY spawn (jcode fails
 * fast when it is missing) and returns the env to merge into the spawn env.
 * Async so the spawn hot path never blocks on a filesystem syscall.
 */
export async function ensureJcodeRuntimeDir(
  paneKey: string,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, string> | undefined> {
  const env = buildJcodeRuntimeDirEnv(paneKey, platform)
  if (env) {
    await mkdir(env[JCODE_RUNTIME_DIR_ENV_KEY], { recursive: true })
  }
  return env
}
