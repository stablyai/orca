// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { useFileExplorerHostMode, type FileExplorerHostMode } from './use-file-explorer-host-mode'

type FakeState = {
  sshTargetLabels: Map<string, string>
  runtimeEnvironments: { id: string; name: string }[]
  fileSearchStateByWorktree: Record<string, { seedRequestId?: number; focusRequestId?: number }>
}

let mockStore: StoreApi<FakeState>

vi.mock('@/store', () => {
  const api = () => mockStore
  const useAppStore = <T,>(selector: (state: FakeState) => T): T => useStore(api(), selector)
  useAppStore.subscribe = (listener: (s: FakeState, p: FakeState) => void) =>
    api().subscribe(listener)
  useAppStore.getState = () => api().getState()
  return { useAppStore }
})
const { ownerKind } = vi.hoisted(() => ({ ownerKind: { current: 'local' } }))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwnerFromState: (state: FakeState) =>
    !state || ownerKind.current === 'unresolved'
      ? { kind: 'unresolved' }
      : ownerKind.current === 'local'
        ? { kind: 'local' }
        : { kind: 'ssh', connectionId: ownerKind.current }
}))
const { visitKeys } = vi.hoisted(() => {
  const visitKeys: (string | null)[] = []
  return { visitKeys }
})
vi.mock('./use-file-explorer-host-browser', () => ({
  useFileExplorerHostBrowser: ({ visitKey }: { visitKey: string | null }) => {
    visitKeys.push(visitKey)
    return {}
  }
}))

let root: Root
let latest: FileExplorerHostMode

function Harness({ worktreeId = 'wt-1' }: { worktreeId?: string }): null {
  latest = useFileExplorerHostMode({ activeWorktreeId: worktreeId, worktreePath: '/repo' })
  return null
}

beforeEach(async () => {
  ownerKind.current = 'local'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mockStore = createStore<FakeState>(() => ({
    sshTargetLabels: new Map(),
    runtimeEnvironments: [],
    fileSearchStateByWorktree: {}
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { browseHostDir: vi.fn(), resolveHostBrowseEntry: vi.fn() } }
  })
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Harness />))
})

afterEach(() => {
  act(() => root.unmount())
})

const api = () => mockStore

describe('useFileExplorerHostMode', () => {
  it('returns to Project mode when a workspace Contents search is requested', async () => {
    await act(async () => latest.enter())
    expect(latest.active).toBe(true)

    await act(async () =>
      api().setState({ fileSearchStateByWorktree: { 'wt-1': { focusRequestId: 1 } } })
    )
    expect(latest.active).toBe(false)

    await act(async () => latest.enter())
    await act(async () =>
      api().setState({
        fileSearchStateByWorktree: { 'wt-1': { focusRequestId: 1, seedRequestId: 3 } }
      })
    )
    expect(latest.active).toBe(false)
  })

  it('ignores search requests for other workspaces', async () => {
    await act(async () => latest.enter())

    await act(async () =>
      api().setState({ fileSearchStateByWorktree: { 'wt-2': { focusRequestId: 1 } } })
    )

    expect(latest.active).toBe(true)
  })

  it('ends Host mode when the user leaves the workspace, even after coming back', async () => {
    await act(async () => latest.enter())
    await act(async () => latest.setFilterQuery('notes'))
    expect(latest.active).toBe(true)

    await act(async () => root.render(<Harness worktreeId="wt-2" />))
    expect(latest.active).toBe(false)

    await act(async () => root.render(<Harness worktreeId="wt-1" />))
    expect(latest.active).toBe(false)
    expect(latest.filterQuery).toBe('')
  })

  it('gives every entry a fresh browsing session so an old listing never reappears', async () => {
    await act(async () => latest.enter())
    const firstVisit = visitKeys.at(-1)
    await act(async () => latest.exit())
    expect(visitKeys.at(-1)).toBeNull()

    await act(async () => latest.enter())

    expect(firstVisit).not.toBeNull()
    expect(visitKeys.at(-1)).not.toBeNull()
    expect(visitKeys.at(-1)).not.toBe(firstVisit)
  })

  it('ends Host mode when the host becomes unavailable, even after it returns', async () => {
    await act(async () => latest.enter())
    expect(latest.active).toBe(true)

    ownerKind.current = 'unresolved'
    await act(async () => api().setState({ fileSearchStateByWorktree: {} }))
    expect(latest.active).toBe(false)

    ownerKind.current = 'local'
    await act(async () => api().setState({ fileSearchStateByWorktree: {} }))
    expect(latest.active).toBe(false)
  })

  it('ends Host mode when the workspace is repointed to another host', async () => {
    ownerKind.current = 'ssh-1'
    await act(async () => api().setState({ fileSearchStateByWorktree: {} }))
    await act(async () => latest.enter())
    expect(latest.active).toBe(true)

    ownerKind.current = 'ssh-2'
    await act(async () => api().setState({ fileSearchStateByWorktree: {} }))
    expect(latest.active).toBe(false)

    ownerKind.current = 'ssh-1'
    await act(async () => api().setState({ fileSearchStateByWorktree: {} }))
    expect(latest.active).toBe(false)
  })
})
