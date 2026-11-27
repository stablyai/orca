// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileListState } from './quick-open-file-list'
import { HookProbe, renderProbe, seedLocalWorktree } from './quick-open-file-list-test-harness'

let settleListing: (paths: string[]) => void = () => {}

beforeEach(() => {
  seedLocalWorktree()
  Object.assign(window, {
    api: {
      ...window.api,
      fs: {
        listFiles: vi.fn(() => new Promise<string[]>((resolve) => (settleListing = resolve))),
        cancelListFiles: vi.fn(async () => undefined)
      }
    }
  })
})

describe('local file listing on enable', () => {
  it('reports loading on the first enabled render when the caller waits on the listing', async () => {
    const states: RuntimeFileListState[] = []
    const probe = { states, worktreeId: 'wt-1', reportLoadingOnEnable: true }
    const root = await renderProbe({ ...probe, enabled: false, query: '' })
    const firstEnabled = states.length

    await act(async () => {
      root.render(createElement(HookProbe, { ...probe, enabled: true, query: 'cart' }))
    })
    // A local listing's key ignores the query; a settled first render would let the Files search's
    // text scan start before the listing's request does.
    expect(states[firstEnabled]?.loading).toBe(true)
  })

  it("keeps a reopened picker's cached rows on its first render by default", async () => {
    const states: RuntimeFileListState[] = []
    const probe = { states, worktreeId: 'wt-1' }
    const root = await renderProbe({ ...probe, enabled: true })
    await act(async () => settleListing(['src/cart.ts']))
    await act(async () => {
      root.render(createElement(HookProbe, { ...probe, enabled: false }))
    })
    const firstReopened = states.length

    await act(async () => {
      root.render(createElement(HookProbe, { ...probe, enabled: true }))
    })
    // Quick Open swaps its rows for "Loading files..." while loading, so the reopen must not flash it.
    expect(states[firstReopened]).toMatchObject({ loading: false, files: ['src/cart.ts'] })
  })
})
