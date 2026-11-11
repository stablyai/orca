import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  state: {
    browserTabsByWorktree: {
      wt: [
        { id: 'tab-a', worktreeId: 'wt' },
        { id: 'tab-b', worktreeId: 'wt' }
      ]
    },
    browserPagesByWorkspace: { 'tab-a': [{ id: 'page-a' }], 'tab-b': [{ id: 'page-b' }] },
    asleepBrowserWorktreeIds: {}
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store.state,
    setState: () => {}
  }
}))
vi.mock('@/store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: () => {}
}))

const {
  isAwaitingReopenAfterSleep,
  isBrowserSandboxUp,
  isSleptBrowserTabAwaitingReopen,
  missingRemotePageAction,
  resetReopenAfterSleepForTest,
  settleReopenAfterSleep,
  sleepWorktreeBrowserTabs
} = await import('./browser-tab-sleep')

type Vm = 'running' | 'suspended'
const WT = 'wt'

/** One moment of the race: the VM record, a wake in flight, and the window's sleep flags. */
function moment(args: {
  vm: Vm
  waking?: boolean
  asleepMark?: boolean
  sleepIntent?: boolean
  goingToSleep?: boolean
  suspendCommitted?: boolean
}) {
  const waking: Record<string, boolean> = {}
  const asleep: Record<string, number> = {}
  if (args.waking) {
    waking[WT] = true
  }
  if (args.asleepMark) {
    asleep[WT] = 1
  }
  const state = {
    ephemeralVmRuntimesByWorkspaceId: { [WT]: { status: args.vm } },
    wakingEphemeralVmWorkspaceIds: waking,
    asleepBrowserWorktreeIds: asleep
  }
  const sleep = {
    sleepIntent: Boolean(args.sleepIntent),
    goingToSleep: Boolean(args.goingToSleep),
    suspendCommitted: Boolean(args.suspendCommitted)
  }
  return {
    up: isBrowserSandboxUp(state, WT, sleep),
    onMissing: (pageId: string) =>
      missingRemotePageAction({
        awaitingReopen: isAwaitingReopenAfterSleep(pageId),
        asleep: Boolean(args.asleepMark),
        sandboxUp: isBrowserSandboxUp(state, WT, sleep)
      })
  }
}

beforeEach(() => {
  resetReopenAfterSleepForTest()
})

describe('wake pressed while the suspend is still being committed (LC2-P1)', () => {
  it('keeps both tabs: they wait through the race and reopen once the sandbox is up', () => {
    sleepWorktreeBrowserTabs(WT, 1)
    expect(isAwaitingReopenAfterSleep('page-a')).toBe(true)

    // +8 s: "Wake to continue" pressed. The asleep mark is cleared, but main is still
    // committing the suspend and the VM record still reads "running": hosts pages vanish.
    const pressed = moment({ vm: 'running', sleepIntent: true, suspendCommitted: true })
    expect(pressed.up).toBe(false)
    expect(pressed.onMissing('page-a')).toBe('wait')
    expect(pressed.onMissing('page-b')).toBe('wait')

    // ~4 s later the VM is suspended, then waking: still nothing opens or closes.
    expect(moment({ vm: 'suspended' }).onMissing('page-a')).toBe('wait')
    expect(moment({ vm: 'suspended', waking: true }).onMissing('page-b')).toBe('wait')
    expect(isAwaitingReopenAfterSleep('page-a')).toBe(true)
    expect(isAwaitingReopenAfterSleep('page-b')).toBe(true)

    // Live: the missing pages reopen in place instead of closing their tabs.
    const live = moment({ vm: 'running' })
    expect(live.up).toBe(true)
    expect(live.onMissing('page-a')).toBe('reopen')
    expect(live.onMissing('page-b')).toBe('reopen')
    // A second "missing" before the new page answers still reopens, never closes.
    expect(live.onMissing('page-a')).toBe('reopen')

    // The new host page answered: from now on a missing page is a real close.
    settleReopenAfterSleep('page-a')
    expect(live.onMissing('page-a')).toBe('close')
    expect(live.onMissing('page-b')).toBe('reopen')
  })

  it('an ordinary sleep and wake still waits while asleep and reopens after', () => {
    sleepWorktreeBrowserTabs(WT, 1)
    expect(moment({ vm: 'suspended', asleepMark: true }).onMissing('page-a')).toBe('wait')
    expect(moment({ vm: 'running' }).onMissing('page-a')).toBe('reopen')
  })

  it('a tab that never slept closes when its host page is gone, as before', () => {
    expect(moment({ vm: 'running' }).onMissing('page-x')).toBe('close')
  })

  it("the host's session snapshot can't drop a slept tab before its page is reopened", () => {
    const pages = { browserPagesByWorkspace: store.state.browserPagesByWorkspace }
    expect(isSleptBrowserTabAwaitingReopen(pages, 'tab-a')).toBe(false)
    sleepWorktreeBrowserTabs(WT, 1)
    expect(isSleptBrowserTabAwaitingReopen(pages, 'tab-a')).toBe(true)
    settleReopenAfterSleep('tab-a')
    settleReopenAfterSleep('page-a')
    expect(isSleptBrowserTabAwaitingReopen(pages, 'tab-a')).toBe(false)
    expect(isSleptBrowserTabAwaitingReopen(pages, 'tab-b')).toBe(true)
  })
})
