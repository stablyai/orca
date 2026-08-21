// Persistence seed for a fresh packaged Orca profile: dismisses onboarding and
// registers a throwaway git repo as a project so the harness can open a
// workspace + terminal without the native "Add Project" folder dialog (which
// Playwright cannot drive).
//
// A first-run profile renders a fullscreen onboarding overlay (`fixed inset-0
// z-[100]`) that intercepts every pointer event; the renderer shows it only
// while `onboarding.closedAt === null` (src/renderer/src/components/onboarding/
// should-show-onboarding.ts), so writing this object to `<userDataDir>/
// orca-data.json` BEFORE launch dismisses it. The app derives the Projects list
// from the persisted `repos` array (src/main/persistence.ts), so a single repo
// entry pointing at a real git checkout makes the project selectable.
//
// IMPORTANT: seed only BEFORE the first launch. The app rewrites orca-data.json
// on quit; overwriting it before the post-update relaunch would destroy the
// persisted session that the cold-restore/survival assertions depend on.
//
// Onboarding flow-version / final-step mirror src/shared/constants
// (ONBOARDING_FLOW_VERSION=4, ONBOARDING_FINAL_STEP=5); refresh if the app bumps
// the flow version, or a stale version re-arms onboarding.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ONBOARDING_FLOW_VERSION = 4
const ONBOARDING_FINAL_STEP = 5

/**
 * Create a throwaway git repo under `dir` and return a persisted `Repo` entry
 * for it. A real checkout (init + one commit) is required — Orca treats a
 * project as a git repository.
 */
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
