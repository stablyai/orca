import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

/** DeepSeek Harness state root: `$DSH_HOME`, else `~/.dsh`, matching the launcher. */
export function resolveDshHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAbsoluteDirOverride(env.DSH_HOME, join(homedir(), '.dsh'))
}

/** `<DSH_HOME>/sessions`, laid out as `<encoded-cwd>/<session-id>/session.v<N>.jsonl[.zstd]`. */
export function resolveDshSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  return join(resolveDshHomeDir(), 'sessions')
}
