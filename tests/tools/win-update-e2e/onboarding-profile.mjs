// Seed onboarding dismissal and a real throwaway repo before FIRST launch, avoiding the undrivable native Add Project dialog.
// Never overwrite before relaunch: quit persists the session under test. Mirror onboarding-defaults flow/final step to prevent rearming.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ONBOARDING_FLOW_VERSION = 4
const ONBOARDING_FINAL_STEP = 5

// Create init+commit checkout and return its persisted Repo record; Orca must recognize a real git project.
export function createSeededRepo(dir) {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'win-update-e2e@orca.test')
  git('config', 'user.name', 'win-update-e2e')
  writeFileSync(path.join(dir, 'README.md'), '# win-update-e2e fixture repo\n')
  git('add', '-A')
  git('commit', '-m', 'seed')
  return {
    id: '00000000-0000-4000-8000-00000000e2e0',
    path: dir,
    displayName: 'e2e-fixture',
    badgeColor: '#888888',
    addedAt: 1
  }
}

/** The persisted profile object: onboarding dismissed + telemetry opted in +
 *  an optional seeded repo. */
export function buildFreshProfile({ repo = null } = {}) {
  return {
    settings: {
      defaultTuiAgent: 'blank',
      telemetry: {
        optedIn: true,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      }
    },
    onboarding: {
      flowVersion: ONBOARDING_FLOW_VERSION,
      closedAt: 1,
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    },
    repos: repo ? [repo] : []
  }
}

/** Write a fresh profile into a userData dir before the FIRST launch only. */
export function seedFreshProfile(userDataDir, profile) {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, 'orca-data.json'), `${JSON.stringify(profile, null, 2)}\n`)
}
