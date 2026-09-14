import { describe, expect, it } from 'vitest'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'
import type * as CmdJRowIndexJump from '@/lib/cmd-j-row-index-jump'

type CmdJRowIndexJumpModule = typeof CmdJRowIndexJump

describe('useIpcEvents digit-chord routing while Cmd+J is open', () => {
  function createPaletteState(activeModal: string | null): HarnessStoreState {
    return createHarnessStoreState({
      tabsByWorktree: {},
      activeModal,
      activeView: 'terminal'
    })
  }

  // Why imported after the harness: it resets the module registry, so the bus the hook publishes on
  // is only the same instance when it's loaded on the far side of that reset.
  async function loadRowJumpBus(): Promise<CmdJRowIndexJumpModule> {
    return import('@/lib/cmd-j-row-index-jump')
  }

  it('routes the workspace digit chord to the palette instead of switching workspaces', async () => {
    const harness = await loadIpcEventsHarness(createPaletteState('worktree-palette'))
    harness.useIpcEvents()
    const rowJumps: number[] = []
    const unsubscribe = (await loadRowJumpBus()).subscribeCmdJRowIndexJump((index) =>
      rowJumps.push(index)
    )

    harness.jumpToWorktreeIndex(2)
    unsubscribe()

    expect(rowJumps).toEqual([2])
  })

  it('leaves the workspace jump alone when the palette is closed', async () => {
    const harness = await loadIpcEventsHarness(createPaletteState(null), {
      visibleWorktreeIds: ['wt-a', 'wt-b', 'wt-c']
    })
    harness.useIpcEvents()
    const rowJumps: number[] = []
    const unsubscribe = (await loadRowJumpBus()).subscribeCmdJRowIndexJump((index) =>
      rowJumps.push(index)
    )

    harness.jumpToWorktreeIndex(2)
    unsubscribe()

    expect(rowJumps).toEqual([])
    // Why assert the activation and not just the silent bus: a premature return would also emit nothing.
    expect(harness.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-c')
  })

  it('routes duplicate ids at different positions to their rendered hosts', async () => {
    const harness = await loadIpcEventsHarness(createPaletteState(null), {
      visibleWorktreeTargets: [
        { id: 'repo::path', executionHostId: 'local' },
        { id: 'repo::path', executionHostId: 'ssh:box' }
      ]
    })
    harness.useIpcEvents()

    harness.jumpToWorktreeIndex(1)

    expect(harness.activateAndRevealWorkspace).toHaveBeenCalledWith('repo::path', {
      executionHostId: 'ssh:box'
    })
  })

  it('drops the tab digit chord rather than switching tabs behind the overlay', async () => {
    const storeState = createPaletteState('worktree-palette')
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.jumpToTabIndex(1)

    expect(storeState.setActiveTab).not.toHaveBeenCalled()
  })

  it('stops delivering row jumps after unsubscribe', async () => {
    const { emitCmdJRowIndexJump, subscribeCmdJRowIndexJump } = await loadRowJumpBus()
    const seen: number[] = []
    const unsubscribe = subscribeCmdJRowIndexJump((index) => seen.push(index))

    emitCmdJRowIndexJump(0)
    unsubscribe()
    emitCmdJRowIndexJump(1)

    expect(seen).toEqual([0])
  })
})
