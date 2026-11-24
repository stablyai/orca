import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../file-access/absolute-dir-override'

/** mcode resolves MINIMAX_DATA_DIR, then its MAVIS_DATA_DIR alias, then ~/.minimax. */
export function resolveMcodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAbsoluteDirOverride(
    env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim(),
    join(homedir(), '.minimax')
  )
}
