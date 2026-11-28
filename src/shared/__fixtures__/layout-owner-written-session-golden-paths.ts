// The session a layout-owner build's main writes for a representative set of layout commands
// (layout-owner-written-session-golden.test.ts), which a switch-off build must restore unchanged.

import { join } from 'node:path'

export const LAYOUT_OWNER_WRITTEN_SESSION_GOLDEN_PATH = join(
  __dirname,
  'layout-owner-written-session.json'
)

/** The fixture profile's registered git worktree (terminal-topology-profile-fixture.ts). */
export const LAYOUT_OWNER_WRITTEN_SESSION_WORKTREE_ID = 'repo-local::/fixture/local'
