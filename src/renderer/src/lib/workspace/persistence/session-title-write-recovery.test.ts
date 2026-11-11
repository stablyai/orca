import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import { applyWorkspaceSessionTerminalTitles } from '../../../../../shared/workspace-session/workspace-session-terminal-titles'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'

let dispose: (() => void) | undefined
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  dispose?.()
  vi.useRealTimers()
})

function setup(supportsTerminalTitlePatches = true) {
  const store = createTestStore()
  const tab = {
    id: 'tab',
    worktreeId: 'repo::/workspace',
    ptyId: 'renderer-pty',
    title: 'original',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  store.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    tabsByWorktree: { 'repo::/workspace': [tab] },
    groupsByWorktree: {
      'repo::/workspace': [
        {
          id: 'group',
          worktreeId: 'repo::/workspace',
          activeTabId: 'unified',
          tabOrder: ['unified']
        }
      ]
    },
    unifiedTabsByWorktree: {
      'repo::/workspace': [
        {
          id: 'unified',
          entityId: 'tab',
          groupId: 'group',
          worktreeId: 'repo::/workspace',
          contentType: 'terminal',
          label: 'original',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  })
  let saved = getDefaultWorkspaceSession()
  const persist = vi.fn((write: WorkspaceSessionWrite): void | Promise<void> => {
    saved = write.terminalTitles
      ? applyWorkspaceSessionTerminalTitles(saved, write.terminalTitles)
      : { ...saved, ...write.patch }
  })
  dispose = createSessionWriteSubscriber({ store, persist, supportsTerminalTitlePatches })
  const rename = (title: string) =>
    store.setState({
      tabsByWorktree: {
        'repo::/workspace': [{ ...tab, title }]
      },
      unifiedTabsByWorktree: {
        'repo::/workspace': store
          .getState()
          .unifiedTabsByWorktree['repo::/workspace'].map((row) => ({ ...row, label: title }))
      }
    })
  return {
    store,
    persist,
    rename,
    read: () => saved,
    replaceSaved: (next: typeof saved) => {
      saved = next
    }
  }
}

it('saves the latest coalesced title without overwriting a newer host PTY', async () => {
  const h = setup()
  await vi.runOnlyPendingTimersAsync()
  const saved = h.read()
  h.replaceSaved({
    ...saved,
    tabsByWorktree: {
      'repo::/workspace': [
        { ...saved.tabsByWorktree['repo::/workspace'][0], ptyId: 'host-replacement' }
      ]
    }
  })
  h.rename('intermediate')
  h.rename('latest')
  await vi.runOnlyPendingTimersAsync()
  expect(h.read().tabsByWorktree['repo::/workspace'][0]).toMatchObject({
    title: 'latest',
    ptyId: 'host-replacement'
  })
  expect(h.read().unifiedTabs?.['repo::/workspace'][0].label).toBe('latest')
})

it('retains a newer title edit while the prior title write is awaiting acknowledgement', async () => {
  const h = setup()
  await vi.runOnlyPendingTimersAsync()
  let acknowledge: () => void = () => {}
  h.persist.mockImplementationOnce(
    (write) =>
      new Promise<void>((resolve) => {
        acknowledge = () => {
          if (!write.terminalTitles) {
            throw new Error('expected targeted title write')
          }
          h.replaceSaved(applyWorkspaceSessionTerminalTitles(h.read(), write.terminalTitles))
          resolve()
        }
      })
  )
  h.rename('in-flight')
  await vi.runOnlyPendingTimersAsync()
  h.rename('newer')
  acknowledge()
  await Promise.resolve()
  await vi.runOnlyPendingTimersAsync()
  expect(h.read().tabsByWorktree['repo::/workspace'][0].title).toBe('newer')
  expect(h.read().unifiedTabs?.['repo::/workspace'][0].label).toBe('newer')
})

it('repairs a partially applied failed write when the title reverts before retry', async () => {
  const h = setup()
  await vi.runOnlyPendingTimersAsync()
  let rejectWrite: (error: Error) => void = () => {}
  h.persist.mockImplementationOnce((write) => {
    if (!write.terminalTitles) {
      throw new Error('expected targeted title write')
    }
    h.replaceSaved(applyWorkspaceSessionTerminalTitles(h.read(), write.terminalTitles))
    return new Promise<void>((_resolve, reject) => {
      rejectWrite = reject
    })
  })
  h.rename('partially-written')
  await vi.runOnlyPendingTimersAsync()
  h.rename('original')
  rejectWrite(new Error('second host unavailable'))
  await Promise.resolve()
  h.store.setState({ sortEpoch: 1 })
  await vi.runOnlyPendingTimersAsync()
  expect(h.read().tabsByWorktree['repo::/workspace'][0].title).toBe('original')
})

it.each([true, false])(
  'persists structural edits and supports older APIs (title patches: %s)',
  async (supported) => {
    const h = setup(supported)
    await vi.runOnlyPendingTimersAsync()
    h.rename('renamed')
    await vi.runOnlyPendingTimersAsync()
    expect(h.read().tabsByWorktree['repo::/workspace'][0].title).toBe('renamed')
    h.store.setState({ tabsByWorktree: {} })
    await vi.runOnlyPendingTimersAsync()
    expect(h.read().tabsByWorktree).toEqual({})
  }
)
