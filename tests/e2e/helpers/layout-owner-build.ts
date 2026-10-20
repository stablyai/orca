import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Whether out/ holds a build where main owns the layout: the shipped default, unless the build was
 * the ORCA_LAYOUT_OWNER=window rollback variant (config/dark-build-switches.cjs marks it).
 */
export const LAYOUT_OWNER_BUILD = !existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_WINDOW')
)
