import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { makeState } from './sync-runtime-graph-test-harness'

describe('mobile file tabs naming a file outside their workspace', () => {
  it.each([
    ['a plain file', 'plaintext', []],
    ['a Markdown file', 'markdown', ['markdown']]
  ] as const)('publish %s only when the phone can read it', (_label, language, types) => {
    const id = '/other/report.txt'
    const state = makeState({
      browserTabsByWorktree: {},
      tabBarOrderByWorktree: { 'wt-1': [id] },
      activeFileId: id,
      activeFileIdByWorktree: { 'wt-1': id },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { 'wt-1': 'editor' },
      openFiles: [
        {
          id,
          filePath: id,
          relativePath: id,
          worktreeId: 'wt-1',
          language,
          mode: 'edit',
          readOnly: true,
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs.map((tab) => tab.type)).toEqual(types)
  })
})
