// Ownership is tab-keyed, so the row a reveal adopts can be filed under a worktree key other
// than the event's. Every surfacing site must follow the owner's key: verifyTerminalRevealIdentity
// looks the tab up under the key it is handed, and throws when that key does not hold it.
import { describe, expect, it } from 'vitest'
import { BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT } from '@/constants/terminal'
import {
  createStoreWithOwnerFiledElsewhere,
  loadIpcEventsHarness,
  OWNER_ELSEWHERE_EVENT_WORKTREE_ID as EVENT_WORKTREE_ID,
  OWNER_ELSEWHERE_OWNER_WORKTREE_ID as OWNER_WORKTREE_ID,
  type IpcEventsHarness
} from './ipc-events-test-harness'

function revealOwnedPane(harness: IpcEventsHarness, presentation: 'background' | 'focused'): void {
  harness.createTerminal({
    requestId: 'reveal',
    worktreeId: EVENT_WORKTREE_ID,
    ptyId: 'pty-a',
    tabId: 'tab-a',
    leafId: 'leaf-a',
    presentation
  })
}

describe('a reveal surfaces its owner under the owner’s worktree key', () => {
  it('activates, reveals and focuses the owner workspace, not the event’s', async () => {
    const storeState = createStoreWithOwnerFiledElsewhere()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealOwnedPane(harness, 'focused')

    expect(storeState.setActiveWorktree).toHaveBeenCalledWith(OWNER_WORKTREE_ID)
    expect(storeState.revealWorktreeInSidebar).toHaveBeenCalledWith(OWNER_WORKTREE_ID)
    expect(harness.focusRuntimeTerminalSurface).toHaveBeenCalledWith(
      'tab-a',
      'leaf-a',
      OWNER_WORKTREE_ID
    )
  })

  it('attests the identity under the owner key, so the reply carries one instead of an error', async () => {
    const storeState = createStoreWithOwnerFiledElsewhere()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealOwnedPane(harness, 'focused')

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'reveal',
      tabId: 'tab-a',
      title: 'Terminal 1',
      identity: {
        worktreeId: OWNER_WORKTREE_ID,
        tabId: 'tab-a',
        leafId: 'leaf-a',
        ptyId: 'pty-a'
      }
    })
  })

  it('background-mounts the owner workspace rather than the event’s', async () => {
    const storeState = createStoreWithOwnerFiledElsewhere()
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealOwnedPane(harness, 'background')

    const mountDetails = harness.dispatchEvent.mock.calls.flatMap((call: unknown[]) => {
      const event = call[0]
      return event instanceof CustomEvent && event.type === BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT
        ? [event.detail]
        : []
    })
    expect(mountDetails).toEqual([{ worktreeId: OWNER_WORKTREE_ID, tabIds: ['tab-a'] }])
  })
})
