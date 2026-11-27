// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import type { RuntimeFileListState } from './quick-open-file-list'
import { HookProbe, renderProbe, seedLocalWorktree } from './quick-open-file-list-test-harness'

it('reports loading on the first render a local listing is enabled', async () => {
  seedLocalWorktree()
  Object.assign(window, {
    api: {
      ...window.api,
      fs: {
        listFiles: vi.fn(() => new Promise<string[]>(() => {})),
        cancelListFiles: vi.fn(async () => undefined)
      }
    }
  })
  const states: RuntimeFileListState[] = []
  const root = await renderProbe({ enabled: false, states, query: '', worktreeId: 'wt-1' })
  const firstEnabled = states.length

  await act(async () => {
    root.render(
      createElement(HookProbe, { enabled: true, states, query: 'cart', worktreeId: 'wt-1' })
    )
  })
  // A local listing's key ignores the query; a settled first render would let callers that wait
  // on the listing (the Files search's text scan) start before its request does.
  expect(states[firstEnabled]?.loading).toBe(true)
})
