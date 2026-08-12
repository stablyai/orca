import { describe, expect, it } from 'vitest'
import { shouldMarkPrimaryWorkspaceTitle } from './worktree-card-model'

// Why: the primary badge is exception-only — a title of "main"/"master"
// already reads as the primary workspace.
describe('shouldMarkPrimaryWorkspaceTitle', () => {
  it('hides the badge for conventional primary titles', () => {
    expect(shouldMarkPrimaryWorkspaceTitle('main')).toBe(false)
    expect(shouldMarkPrimaryWorkspaceTitle('master')).toBe(false)
    expect(shouldMarkPrimaryWorkspaceTitle(' Main ')).toBe(false)
    expect(shouldMarkPrimaryWorkspaceTitle('MASTER')).toBe(false)
  })

  it('marks renamed primaries whose title no longer says main', () => {
    expect(shouldMarkPrimaryWorkspaceTitle('release prep')).toBe(true)
    expect(shouldMarkPrimaryWorkspaceTitle('main-backup')).toBe(true)
    expect(shouldMarkPrimaryWorkspaceTitle('')).toBe(true)
  })
})
