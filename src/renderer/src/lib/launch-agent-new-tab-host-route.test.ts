import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  launchAgentThroughHost: vi.fn()
}))
vi.mock('@/lib/agent-launch-through-host', () => host)
const pasteAgentLaunchPromptOnceReady = vi.hoisted(() =>
  vi.fn(async (_args: { launchPty?: Promise<string | null> }) => ({
    delivered: true,
    failureNotified: false
  }))
)
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({ pasteAgentLaunchPromptOnceReady }))

const { launchNewTabPromptThroughHost, newTabPromptLaunchesThroughHost } =
  await import('./launch-agent-new-tab-host-route')

const TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function deferredStart() {
  let resolve!: (startedPtyId: string | null) => void
  const started = new Promise<string | null>((done) => (resolve = done))
  host.launchAgentThroughHost.mockReturnValue({ tabId: TAB, started })
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
})

describe('an AI button launched in its own pane', () => {
  function launchPty(): Promise<string | null> {
    const pty = pasteAgentLaunchPromptOnceReady.mock.calls.at(-1)?.[0].launchPty
    if (!pty) {
      throw new Error("the paste was set up without the launch pane's PTY")
    }
    return pty
  }

  // Why: the paste must meet the agent its pane started, never another pane or a failed launch.
  it("pastes into the PTY its pane's spawn started the agent in", async () => {
    const answer = deferredStart()
    const { tabId, promptDeliveryResult } = launch()
    expect(pasteAgentLaunchPromptOnceReady).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tabId, worktreeId: 'wt-1', submit: true })
    )
    let startedPty: string | null | undefined
    void launchPty().then((ptyId) => (startedPty = ptyId))
    await Promise.resolve()
    expect(startedPty).toBeUndefined()

    answer('pty-agent')

    await expect(launchPty()).resolves.toBe('pty-agent')
    await expect(promptDeliveryResult).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(tabId).toBe(TAB)
  })

  it('never pastes for a launch that did not start, whose pane or notice already said why', async () => {
    deferredStart()(null)
    await expect(launch().promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    await expect(launchPty()).resolves.toBeNull()
  })
})

describe('which new agent tabs start through the host', () => {
  it('an AI button whose prompt is pasted once ready, in a terminal this window makes', () => {
    expect(
      newTabPromptLaunchesThroughHost({
        promptDelivery: 'submit-after-ready',
        pastesPrompt: true,
        isRemote: false
      })
    ).toBe(true)
  })

  it('leaves typed prompts and SSH on their existing routes', () => {
    expect(
      newTabPromptLaunchesThroughHost({
        promptDelivery: 'auto-submit',
        pastesPrompt: true,
        isRemote: false
      })
    ).toBe(false)
    expect(
      newTabPromptLaunchesThroughHost({
        promptDelivery: 'draft',
        pastesPrompt: true,
        isRemote: false
      })
    ).toBe(false)
    // A workspace that runs over SSH: the pane's local spawn cannot start it.
    expect(
      newTabPromptLaunchesThroughHost({
        promptDelivery: 'submit-after-ready',
        pastesPrompt: true,
        isRemote: true
      })
    ).toBe(false)
  })
})
