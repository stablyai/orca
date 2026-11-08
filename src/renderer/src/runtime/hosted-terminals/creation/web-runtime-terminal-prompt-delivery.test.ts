import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverCreatedWebRuntimeAgentSessionPrompt } from '@/runtime/hosted-terminals/creation/web-runtime-created-agent-prompt-delivery'
import { useAppStore } from '@/store/index'

const mocks = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<boolean>>(),
  write: vi.fn<(_pty: string, _data: string) => Promise<boolean>>(),
  draft: vi.fn()
}))
vi.mock('@/lib/agent-draft-readiness', () => ({ waitForAgentDraftInputReady: mocks.ready }))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: mocks.write
}))

const originalState = useAppStore.getState()
const ptyId = 'remote:env@@pty-1'
const created = { outcome: { status: 'created' as const }, hostTabId: 'host-adopted' }
function deliver(beforePaste = () => true) {
  return deliverCreatedWebRuntimeAgentSessionPrompt(created, {
    agent: 'codex',
    promptAfterReady: 'ship it\nwith tests',
    forcePromptPaste: true,
    launchPty: Promise.resolve(ptyId),
    beforePaste
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.ready.mockReset()
  mocks.write.mockResolvedValue(true)
  vi.stubGlobal('window', {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  })
  useAppStore.setState({ seedNativeChatLaunchDraft: mocks.draft })
})
afterEach(() => {
  useAppStore.setState(originalState, true)
  vi.unstubAllGlobals()
})

it('ends a lost-pane attempt without writing or replaying when readiness later returns', async () => {
  const ready = Promise.withResolvers<boolean>()
  mocks.ready.mockReturnValue(ready.promise)
  let connected = true
  const pending = deliver(() => connected)
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce())
  connected = false
  ready.resolve(true)
  await expect(pending).resolves.toBe(false)
  connected = true
  useAppStore.setState({ ptyIdsByTabId: { 'web-terminal-host-adopted': [ptyId] } })
  expect(mocks.write).not.toHaveBeenCalled()
})
