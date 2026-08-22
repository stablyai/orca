import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeLayout,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { captureTerminalWindowTransferSeed } from './terminal-tab-window-transfer'

const kill = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  kill.mockClear()
  globalThis.window = { api: { pty: { kill } } } as never
})

function seedTerminal(store: ReturnType<typeof createTestStore>) {
  const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-a', color: '#f00' })
  const unified = makeUnifiedTab({ id: tab.id, worktreeId: 'wt-1', groupId: 'group-1' })
  const group = makeTabGroup({
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: tab.id,
    tabOrder: [tab.id]
  })
  const layout = {
    ...makeLayout(),
    root: { type: 'leaf' as const, leafId: 'leaf-1' },
    activeLeafId: 'leaf-1',
    ptyIdsByLeafId: { 'leaf-1': 'pty-a', 'leaf-2': 'pty-b' },
    buffersByLeafId: { 'leaf-1': 'buffer' },
    scrollbackRefsByLeafId: { 'leaf-1': 'scrollback-ref' }
  }
  seedStore(store, {
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: 'wt-1',
    activeWorkspaceKey: 'worktree:wt-1',
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })]
    },
    tabsByWorktree: { 'wt-1': [tab] },
    unifiedTabsByWorktree: { 'wt-1': [unified] },
    groupsByWorktree: { 'wt-1': [group] },
    activeGroupIdByWorktree: { 'wt-1': group.id },
    ptyIdsByTabId: { [tab.id]: ['pty-a', 'pty-b', 'pty-a'] },
    terminalLayoutsByTabId: { [tab.id]: layout }
  })
  return { tab, group, layout }
}

describe('terminal tab window transfer', () => {
  it('captures a deep terminal seed with stable unique PTY ids', () => {
    const store = createTestStore()
    const { layout } = seedTerminal(store)

    const result = captureTerminalWindowTransferSeed(store.getState(), 'tab-1')

    expect(result).toMatchObject({
      ok: true,
      seed: {
        tabId: 'tab-1',
        hostId: 'local',
        canonicalWorkspaceKey: 'worktree:wt-1',
        ptyIds: ['pty-a', 'pty-b'],
        layout: {
          buffersByLeafId: { 'leaf-1': 'buffer' },
          scrollbackRefsByLeafId: { 'leaf-1': 'scrollback-ref' }
        }
      }
    })
    layout.buffersByLeafId!['leaf-1'] = 'mutated'
    expect(result.ok && result.seed.layout.buffersByLeafId?.['leaf-1']).toBe('buffer')
  })

  it('derives an unambiguous local workspace identity when activation fields are absent', () => {
    const store = createTestStore()
    seedTerminal(store)
    seedStore(store, {
      activeRepoId: null,
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null
    })

    expect(captureTerminalWindowTransferSeed(store.getState(), 'tab-1')).toMatchObject({
      ok: true,
      seed: {
        canonicalWorkspaceKey: 'worktree:wt-1',
        hostId: 'local',
        repo: { id: TEST_REPO.id }
      }
    })
  })

  it('rejects a non-terminal or incomplete transfer without changing state', () => {
    const store = createTestStore()
    seedTerminal(store)
    const before = store.getState()

    const result = captureTerminalWindowTransferSeed(store.getState(), 'missing-tab')

    expect(result).toEqual({ ok: false, error: 'terminal_tab_not_found' })
    expect(store.getState()).toBe(before)
  })

  it('imports and removes a transfer idempotently without killing its PTYs', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const target = createTestStore()
    seedStore(target, { repos: [] })

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    expect(target.getState().tabsByWorktree['wt-1']).toEqual([captured.seed.tab])
    expect(target.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-a', 'pty-b'])
    expect(target.getState().terminalLayoutsByTabId['tab-1']).toEqual(captured.seed.layout)

    expect(target.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    expect(target.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    expect(target.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(kill).not.toHaveBeenCalled()
  })
})
