import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), setState: () => {} } }))
vi.mock('@/store/slices/browser/cleanup/browser-webview-cleanup', () => ({
  destroyWorktreeBrowserGuests: () => {}
}))

const { isBackAfterHeldSleep, isBrowserSandboxUp } = await import('./browser-tab-sleep')

const WT = 'wt'
type Flags = { held?: boolean; goingToSleep?: boolean; suspendCommitted?: boolean }
const view = (flags: Flags) => ({
  held: () => Boolean(flags.held),
  goingToSleep: () => Boolean(flags.goingToSleep),
  suspendCommitted: () => Boolean(flags.suspendCommitted)
})
const state = (vm: 'running' | 'suspended', waking = false) => {
  const wakingIds: Record<string, boolean> = {}
  if (waking) {
    wakingIds[WT] = true
  }
  return {
    activeWorktreeId: WT,
    asleepBrowserWorktreeIds: { [WT]: 1 },
    ephemeralVmRuntimesByWorkspaceId: { [WT]: { status: vm } },
    wakingEphemeralVmWorkspaceIds: wakingIds
  }
}

describe('wake pressed on the held asleep view, workspace never re-activated (d3 smoke, #399)', () => {
  it('keeps the tabs asleep through the suspend and the wake, then wakes them when the VM is up', () => {
    // Sleep in flight, Wake to continue pressed: still held, suspend being committed.
    expect(
      isBackAfterHeldSleep(state('running'), view({ held: true, suspendCommitted: true }))
    ).toBeNull()
    expect(isBackAfterHeldSleep(state('suspended'), view({ held: true }))).toBeNull()
    expect(isBackAfterHeldSleep(state('suspended', true), view({}))).toBeNull()
    // Live: the VM runs and the view is released, with no activation change.
    expect(isBackAfterHeldSleep(state('running'), view({}))).toBe(WT)
  })

  it('a lingering sleep intent no longer blocks reopening pages once the VM itself is up', () => {
    const live = {
      ephemeralVmRuntimesByWorkspaceId: { [WT]: { status: 'running' } },
      wakingEphemeralVmWorkspaceIds: {},
      asleepBrowserWorktreeIds: {}
    }
    expect(
      isBrowserSandboxUp(live, WT, {
        sleepIntent: true,
        goingToSleep: false,
        suspendCommitted: false
      })
    ).toBe(true)
    // Without a VM, the sleep intent still decides.
    expect(
      isBrowserSandboxUp({ asleepBrowserWorktreeIds: {} }, WT, {
        sleepIntent: true,
        goingToSleep: false,
        suspendCommitted: false
      })
    ).toBe(false)
  })
})
