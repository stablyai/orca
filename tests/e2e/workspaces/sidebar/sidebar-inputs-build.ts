import { existsSync } from 'node:fs'
import path from 'node:path'

/** Whether out/ holds an ORCA_SIDEBAR_INPUTS=main build (config/dark-build-switches.cjs marks it). */
export const SIDEBAR_INPUTS_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_SIDEBAR_INPUTS_MAIN')
)
