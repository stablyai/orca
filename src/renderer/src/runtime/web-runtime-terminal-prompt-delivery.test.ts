import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverCreatedWebRuntimeAgentSessionPrompt } from './web-runtime-terminal-creation'
import {
  rebindPendingAgentStartupPrompt,
  resetAgentStartupDelayedDeliveryForTests
} from '../lib/agent-startup-delayed-delivery'
import {
  agentStartupDeliveryKey,
  isAgentStartupDeliveryConsumed,
  forgetAgentStartupDeliveriesForTabs
} from '../lib/agent-startup-delivery-guards'

const mocks = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<boolean>>(),
  write: vi.fn<(_pty: string, _data: string) => Promise<boolean>>(),
  error: vi.fn(),
  draft: vi.fn(),
  prompt: vi.fn(),
  failed: vi.fn(),
  state: {
    tabsByWorktree: { wt: [{ id: 'tab-1' }] },
    pendingStartupByTabId: {},
    agentLaunchConfigByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.state,
      seedNativeChatLaunchDraft: mocks.draft,
      seedNativeChatLaunchPrompt: mocks.prompt,
      markNativeChatLaunchPromptFailed: mocks.failed
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('../lib/agent-draft-readiness', () => ({ waitForAgentDraftInputReady: mocks.ready }))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: mocks.write
}))

const identity = { worktreeId: 'wt', tabId: 'tab-1', launchToken: 'launch-1' }
const created = { outcome: { status: 'created' as const } }
function deliver(content = 'ship it\nwith tests', submit = false, beforePaste = () => true) {
  return deliverCreatedWebRuntimeAgentSessionPrompt(created, {
    agent: 'codex',
    rendererTabId: 'tab-1',
    startupDelivery: identity,
    promptAfterReady: content,
    submitPrompt: submit,
    forcePromptPaste: true,
    launchPty: Promise.resolve('pty-1'),
    beforePaste
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  })
  mocks.write.mockResolvedValue(true)
})
afterEach(() => {
  resetAgentStartupDelayedDeliveryForTests()
  vi.unstubAllGlobals()
})

it('keeps an unattempted draft through disconnect and replacement, reports once, and mirrors the renderer tab', async () => {
  const firstReady = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValueOnce(firstReady.promise).mockResolvedValue(true)
  let connected = true
  const first = deliver(undefined, false, () => connected)
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
  connected = false
  firstReady.resolve(false)
  await expect(first).resolves.toBe(false)
  expect(mocks.write).not.toHaveBeenCalled()
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(false)
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    'Orca opened a terminal for Codex, but could not pass it your prompt. Send the prompt in that terminal.'
  )
  expect(mocks.draft).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 'tab-1', text: 'ship it\nwith tests' })
  )
  rebindPendingAgentStartupPrompt({
    ...identity,
    ptyId: 'pty-replacement',
    beforePaste: () => true
  })
  await vi.waitFor(() =>
    expect(mocks.write).toHaveBeenCalledWith(
      'pty-replacement',
      '\x1b[200~ship it\rwith tests\x1b[201~',
      'launch'
    )
  )
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(true)
  expect(mocks.error).toHaveBeenCalledOnce()
  forgetAgentStartupDeliveriesForTabs(['tab-1'])
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(false)
})

it('keeps the initial readiness attempt when its pane confirms the same PTY', async () => {
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValue(ready.promise)
  const result = deliver()
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
  rebindPendingAgentStartupPrompt({ ...identity, ptyId: 'pty-1', beforePaste: () => true })
  ready.resolve(true)
  await expect(result).resolves.toBe(true)
  expect(mocks.error).not.toHaveBeenCalled()
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(
    'pty-1',
    '\x1b[200~ship it\rwith tests\x1b[201~',
    'launch'
  )
})

it('claims at the first write and never replays partially accepted input', async () => {
  mocks.ready.mockResolvedValue(true)
  mocks.write.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  await expect(deliver('x'.repeat(70_000))).resolves.toBe(false)
  expect(mocks.write.mock.calls[0]).toEqual(['pty-1', '\x1b[200~', 'launch'])
  expect(isAgentStartupDeliveryConsumed(agentStartupDeliveryKey(identity))).toBe(true)
  const writes = mocks.write.mock.calls.length
  rebindPendingAgentStartupPrompt({
    ...identity,
    ptyId: 'pty-replacement',
    beforePaste: () => true
  })
  await expect(deliver('x'.repeat(70_000))).resolves.toBe(false)
  expect(mocks.write).toHaveBeenCalledTimes(writes)
  expect(mocks.error).toHaveBeenCalledOnce()
})
