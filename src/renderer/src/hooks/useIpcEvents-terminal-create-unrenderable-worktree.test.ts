import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'

const LISTED_WORKTREE_ID = 'wt-1'
const UNLISTED_WORKTREE_ID = 'repo-1::/unlisted'
const SURFACE_ERROR =
  'Terminal creation is unavailable because this window has no surface for that worktree'

describe('useIpcEvents terminal create unrenderable worktree (#18224)', () => {
  it('refuses a background renderer-backed create when the repo is known but the worktree has no surface', async () => {
    const storeState = createHarnessStoreState({ tabsByWorktree: {} })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.requestTerminalCreate({
      requestId: 'req-unlisted-background',
      worktreeId: UNLISTED_WORKTREE_ID,
      title: 'Claude',
      command: 'claude',
      presentation: 'background'
    })

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledTimes(1)
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-unlisted-background',
      error: SURFACE_ERROR
    })
  })

  it('still creates a background tab for a listed worktree', async () => {
    const storeState = createHarnessStoreState({ tabsByWorktree: {} })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.requestTerminalCreate({
      requestId: 'req-listed-background',
      worktreeId: LISTED_WORKTREE_ID,
      title: 'Claude',
      command: 'claude',
      presentation: 'background'
    })

    expect(storeState.createTab).toHaveBeenCalledWith(LISTED_WORKTREE_ID, undefined, undefined, {
      activate: false,
      recordInteraction: false
    })
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-listed-background',
      tabId: 'tab-minted',
      title: 'Claude'
    })
  })

  it('still mints a focused create for a catalog-missing worktree', async () => {
    const storeState = createHarnessStoreState({ tabsByWorktree: {} })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.requestTerminalCreate({
      requestId: 'req-unlisted-focused',
      worktreeId: UNLISTED_WORKTREE_ID,
      title: 'Claude',
      command: 'claude',
      presentation: 'focused'
    })

    expect(storeState.createTab).toHaveBeenCalledWith(
      UNLISTED_WORKTREE_ID,
      undefined,
      undefined,
      undefined
    )
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-unlisted-focused',
      tabId: 'tab-minted',
      title: 'Claude'
    })
  })

  it('still creates a background tab for a floating terminal surface', async () => {
    const storeState = createHarnessStoreState({ tabsByWorktree: {} })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.requestTerminalCreate({
      requestId: 'req-floating-background',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      presentation: 'background'
    })

    expect(storeState.createTab).toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-floating-background',
      tabId: 'tab-minted',
      title: undefined
    })
  })
})
