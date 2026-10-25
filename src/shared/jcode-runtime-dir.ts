// jcode shares a daemon per runtime directory, including sockets/lock. Isolate per pane so daemon hooks inherit that pane’s ORCA_PANE_KEY;
// otherwise later panes connect to the first daemon and report status to its tab.
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const JCODE_RUNTIME_DIR_ENV_KEY = 'JCODE_RUNTIME_DIR'

// runtimeDir/jcode.sock must fit 104 bytes. Long TMPDIR plus full 73-character pane keys cannot; a stable 16-hex digest keeps paths short.
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

/** Create before PTY spawn because jcode requires the directory; use async I/O on the hot path.
 * Every local pane receives this env, so failures must fall back to jcode’s default daemon rather than prevent ordinary shells from opening. */
export async function ensureJcodeRuntimeDir(
  paneKey: string,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, string> | undefined> {
  const env = buildJcodeRuntimeDirEnv(paneKey, platform)
  if (!env) {
    return undefined
  }
  try {
    await mkdir(env[JCODE_RUNTIME_DIR_ENV_KEY], { recursive: true })
  } catch {
    return undefined
  }
  return env
}
