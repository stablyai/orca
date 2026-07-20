import { describe, expect, it } from 'vitest'
import {
  getFolderWorkspaceCheckoutNotice,
  getFolderWorkspacePrimaryActionLabel
} from './folder-workspace-composer-copy'

describe('folder workspace composer copy', () => {
  it('uses a stable shared-workspace action independent of quick agent selection', () => {
    const label = (getFolderWorkspacePrimaryActionLabel as (...args: unknown[]) => string)({
      id: 'codex'
    })

    expect(label).toBe('Open shared workspace')
    expect(label).not.toContain('Agent')
  })

  it('explains that folder workspaces reuse shared checkouts', () => {
    expect(getFolderWorkspaceCheckoutNotice()).toBe(
      'Uses the existing checkouts in this folder. Branches and file changes are shared with other workspaces; Orca does not create isolated worktrees for each repository.'
    )
  })
})
