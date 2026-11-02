import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from './absolute-dir-override'

/** Kiro CLI's config root: `$KIRO_HOME` replaces `~/.kiro` outright (verified on kiro-cli 2.28). */
export function resolveKiroHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAbsoluteDirOverride(env.KIRO_HOME, join(homedir(), '.kiro'))
}
