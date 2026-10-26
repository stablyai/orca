import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'
import { makeState } from '../sync-runtime-graph-test-harness'

function listedMarkdownTab(isUntitled: boolean | undefined) {
  const state = makeState({
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: { 'wt-1': ['/repo/untitled.md'] },
    openFiles: [
      {
        id: '/repo/untitled.md',
        filePath: '/repo/untitled.md',
        relativePath: 'untitled.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit',
        isDirty: true,
        ...(isUntitled === undefined ? {} : { isUntitled })
      }
    ]
  })
  return buildMobileSessionTabSnapshots(state)[0]?.tabs.find((tab) => tab.type === 'markdown')
}

describe('a listed Markdown tab', () => {
  it('says when its document is untitled, so a phone save cannot make the file', () => {
    expect(listedMarkdownTab(true)).toMatchObject({ isUntitled: true })
  })

  it('omits the flag for a named document', () => {
    expect(listedMarkdownTab(undefined)).not.toHaveProperty('isUntitled')
    expect(listedMarkdownTab(false)).not.toHaveProperty('isUntitled')
  })
})
