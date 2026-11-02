import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession persisted editor ids', () => {
  it.each([
    { id: 'persisted-open-file-id', expectedId: 'persisted-open-file-id' },
    { id: 123, expectedId: undefined }
  ])('keeps the file when its id is $id', ({ id, expectedId }) => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: 'wt',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        wt: [
          {
            id,
            filePath: '/tmp/a.ts',
            relativePath: 'a.ts',
            worktreeId: 'wt',
            language: 'typescript'
          }
        ]
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const file = result.value.openFilesByWorktree?.wt?.[0]
      expect(file?.filePath).toBe('/tmp/a.ts')
      expect(file?.id).toBe(expectedId)
    }
  })
})
