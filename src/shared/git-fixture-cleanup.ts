import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

// Why: machine-level git daemons (e.g. trace2 writers) can drop files into a
// fixture repo between the last git call and teardown — retry the sweep so it
// wins the race instead of failing ENOTEMPTY.
const GIT_FIXTURE_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50
} as const

export function removeGitFixtureDir(dir: string): Promise<void> {
  return rm(dir, GIT_FIXTURE_RM_OPTIONS)
}

export function removeGitFixtureDirSync(dir: string): void {
  rmSync(dir, GIT_FIXTURE_RM_OPTIONS)
}
