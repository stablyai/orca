import { describe, expect, it } from 'vitest'
import { workspaceRenameUnsupportedReason } from './workspace-rename-target'

describe('workspaceRenameUnsupportedReason', () => {
  it('renames a Projects row and a bot’s worker line', () => {
    expect(
      workspaceRenameUnsupportedReason({
        section: 'projects',
        worktreeId: 'wt',
        executionHostId: 'local'
      })
    ).toBeNull()
    expect(
      workspaceRenameUnsupportedReason({
        section: 'bots',
        entryKey: 'local/bot',
        worker: { id: 'wt', hostId: 'local', identity: 'local|wt', ancestors: [] },
        hostDown: false
      })
    ).toBeNull()
  })

  it('explains why bot pages and hidden workspaces cannot be renamed', () => {
    expect(
      workspaceRenameUnsupportedReason({ section: 'bots', entryKey: 'local/bot', hostDown: false })
    ).toMatch(/isn’t a worktree/)
    expect(workspaceRenameUnsupportedReason({ section: 'none', reason: 'bot-hidden' })).toMatch(
      /isn’t listed/
    )
  })
})
