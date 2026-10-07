import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAgentLaunchOutcome } from './agent-launch-through-host'

const host = vi.hoisted(() => ({
  launchAgentThroughHost: vi.fn(),
  windowMakesHostLaunchTab: vi.fn(() => true)
}))
vi.mock('@/lib/agent-launch-through-host', () => host)
const pasteAgentLaunchPromptOnceReady = vi.hoisted(() =>
  vi.fn(async (_args: { sendGate?: Promise<boolean> }) => ({
    delivered: true,
    failureNotified: false
  }))
)
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({ pasteAgentLaunchPromptOnceReady }))
const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { launchNewTabPromptThroughHost, newTabPromptLaunchesThroughHost } =
  await import('./launch-agent-new-tab-host-route')

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function deferredOutcome() {
  let resolve!: (outcome: HostAgentLaunchOutcome) => void
  const promise = new Promise<HostAgentLaunchOutcome>((done) => (resolve = done))
  host.launchAgentThroughHost.mockReturnValue({ tabId: TAB, outcome: promise })
  return resolve
}

function launch() {
  return launchNewTabPromptThroughHost({
    agent: 'claude',
    worktreeId: 'wt-1',
    prompt: 'fix the failing checks',
    pasteContent: 'fix the failing checks',
    submit: true
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  host.windowMakesHostLaunchTab.mockReturnValue(true)
})

describe('an AI button launched through the host', () => {
  function sendGate(): Promise<boolean> {
    const gate = pasteAgentLaunchPromptOnceReady.mock.calls.at(-1)?.[0].sendGate
    if (!gate) {
      throw new Error('the paste was set up without a send gate')
    }
    return gate
  }

  // Why: readiness is watched from the tab's first output, as main watches it, but the paste must
  // meet the host's agent, never a shell this window spawned first.
  it('watches for readiness at once but writes only once the host has its agent in the tab', async () => {
    const answer = deferredOutcome()
    const { tabId, promptDeliveryResult } = launch()
    expect(pasteAgentLaunchPromptOnceReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tabId, worktreeId: 'wt-1', submit: true })
    )
    let gateOpen: boolean | undefined
    void sendGate().then((open) => (gateOpen = open))
    await Promise.resolve()
    expect(gateOpen).toBeUndefined()

    answer({ kind: 'started' })

    await expect(sendGate()).resolves.toBe(true)
    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(tabId).toBe(TAB)
  })

  it('never pastes for a launch refused before the agent ran, and says so once', async () => {
    deferredOutcome()({ kind: 'not-started', unconfirmed: false, code: 'worktree_not_found' })

    await expect(launch().promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    await expect(sendGate()).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledOnce()
  })

  it('says nothing and pastes nothing when the user closed the tab, or its pane explains', async () => {
    for (const outcome of [{ kind: 'closed-by-user' }, { kind: 'pane-says' }] as const) {
      deferredOutcome()(outcome)
      await expect(launch().promptDeliveryResult).resolves.toEqual({
        delivered: false,
        failureNotified: true
      })
      await expect(sendGate()).resolves.toBe(false)
    }
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('which new agent tabs start through the host', () => {
  it('an AI button whose prompt is pasted once ready, in a terminal this window makes', () => {
    expect(
      newTabPromptLaunchesThroughHost({ promptDelivery: 'submit-after-ready', pastesPrompt: true })
    ).toBe(true)
  })

  it('never a typed prompt, nor a launch the host could turn into a chat', () => {
    expect(
      newTabPromptLaunchesThroughHost({ promptDelivery: 'auto-submit', pastesPrompt: true })
    ).toBe(false)
    expect(newTabPromptLaunchesThroughHost({ promptDelivery: 'draft', pastesPrompt: true })).toBe(
      false
    )
    host.windowMakesHostLaunchTab.mockReturnValue(false)
    expect(
      newTabPromptLaunchesThroughHost({ promptDelivery: 'submit-after-ready', pastesPrompt: true })
    ).toBe(false)
  })
})
