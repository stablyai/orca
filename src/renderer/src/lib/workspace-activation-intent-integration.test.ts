import { describe, expect, it } from 'vitest'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import {
  beginWorkspaceActivationIntent,
  isCurrentWorkspaceActivationIntent
} from './workspace-activation-intent'

describe('workspace activation intent integration', () => {
  it('is superseded by direct worktree activation attempts', () => {
    const pendingIntent = beginWorkspaceActivationIntent()

    expect(activateAndRevealWorktree('missing-worktree')).toBe(false)
    expect(isCurrentWorkspaceActivationIntent(pendingIntent)).toBe(false)
  })

  it('is superseded by direct folder workspace activation attempts', () => {
    const pendingIntent = beginWorkspaceActivationIntent()

    expect(activateAndRevealFolderWorkspace('missing-folder-workspace')).toBe(false)
    expect(isCurrentWorkspaceActivationIntent(pendingIntent)).toBe(false)
  })
})
