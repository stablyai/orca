// The paste lane's only gate used to be DECSET 2004 plus render-quiet, which a TUI drawing its
// OWN sign-in dialog satisfies perfectly. These cases drive the whole lane — readiness, guard,
// PTY write — and assert the bytes never leave when a credential prompt owns the pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRendererParityTerminal,
  writeToTerminal
} from '../../../shared/terminal-restore-parity-fixture'
import { registerPtyVisibleScreen } from '@/components/terminal-pane/pty-visible-screen-registry'
import {
  pasteDraftToAgentPtyWhenReady,
  pasteDraftWhenAgentReady,
  submitPromptToAgentPty
} from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  appState: {
    settings: {},
    ptyIdsByTabId: { 'tab-1': ['pty-1'] } as Record<string, string[]>,
    runtimePaneTitlesByTabId: {} as Record<string, unknown>,
    tabsByWorktree: {} as Record<string, { id: string }[]>
  },
  ptyObserver: null as ((data: string) => void) | null,
  unsubscribe: vi.fn(),
  subscribeToPtyData: vi.fn(),
  replayPreHandlerPtyData: vi.fn(),
  isRemoteRuntimePtyId: vi.fn(),
  sendRuntimePtyInputVerified: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  subscribeToRuntimeTerminalData: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: testState.subscribeToPtyData
}))

vi.mock('@/components/terminal-pane/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: testState.replayPreHandlerPtyData
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: testState.isRemoteRuntimePtyId,
  sendRuntimePtyInputVerified: testState.sendRuntimePtyInputVerified,
  inspectRuntimeTerminalProcess: testState.inspectRuntimeTerminalProcess
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  subscribeToRuntimeTerminalData: testState.subscribeToRuntimeTerminalData
}))

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT_RENDER = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const PROMPT = 'Implement the login form'
const PASTED_PROMPT = `\x1b[200~${PROMPT}\x1b[201~`
const SIGN_IN_DIALOG = [
  'Antigravity CLI',
  'gemini 3 pro (high)',
  '>',
  '',
  '  Sign in to Antigravity',
  '  Open https://antigravity.google/device and enter the code: KXTD-9PQR',
  '  Waiting for authentication…'
]
const ANSWERED_DIALOG = ['Signed in as neil@example.com.', '', '› Ask Codex to do anything']

const cleanups: (() => void)[] = []

async function showOnPane(ptyId: string, lines: string[]): Promise<void> {
  const { terminal } = createRendererParityTerminal({ cols: 120, rows: 24 })
  await writeToTerminal(terminal, `\x1b[H\x1b[2J${lines.join('\r\n')}`)
  cleanups.push(registerPtyVisibleScreen(ptyId, terminal))
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function driveCodexToReady(): void {
  testState.ptyObserver?.(DECSET_BRACKETED_PASTE)
  testState.ptyObserver?.(CODEX_COMPOSER_PROMPT_RENDER)
}

describe('the agent paste lane refuses a live credential prompt', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    testState.appState.settings = {}
    testState.appState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    testState.appState.runtimePaneTitlesByTabId = {}
    testState.appState.tabsByWorktree = {}
    testState.ptyObserver = null
    testState.unsubscribe.mockReset()
    testState.subscribeToPtyData.mockReset()
    testState.subscribeToPtyData.mockImplementation(
      (_ptyId: string, observer: (data: string) => void) => {
        testState.ptyObserver = observer
        return testState.unsubscribe
      }
    )
    testState.replayPreHandlerPtyData.mockReset()
    testState.isRemoteRuntimePtyId.mockReset()
    testState.isRemoteRuntimePtyId.mockReturnValue(false)
    testState.sendRuntimePtyInputVerified.mockReset()
    testState.sendRuntimePtyInputVerified.mockResolvedValue(true)
    testState.inspectRuntimeTerminalProcess.mockReset()
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({ foregroundProcess: 'codex' })
    testState.subscribeToRuntimeTerminalData.mockReset()
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    vi.unstubAllGlobals()
  })

  it('writes nothing to the PTY when the pane shows a sign-in dialog', async () => {
    await showOnPane('pty-1', SIGN_IN_DIALOG)
    const onUndelivered = vi.fn()
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: PROMPT,
      agent: 'codex',
      submit: true,
      onUndelivered
    })
    await flushMicrotasks()
    driveCodexToReady()

    await expect(promise).resolves.toBe(false)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(onUndelivered).toHaveBeenCalledExactlyOnceWith('credential-prompt')
  })

  it('defers rather than drops: the same content lands once the dialog is answered', async () => {
    await showOnPane('pty-1', SIGN_IN_DIALOG)
    const refused = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: PROMPT,
      agent: 'codex',
      submit: true
    })
    await flushMicrotasks()
    driveCodexToReady()
    await expect(refused).resolves.toBe(false)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()

    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    await showOnPane('pty-1', ANSWERED_DIALOG)
    const retried = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: PROMPT,
      agent: 'codex'
    })
    await flushMicrotasks()
    driveCodexToReady()

    await expect(retried).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith({}, 'pty-1', PASTED_PROMPT)
  })

  it('still pastes into a legitimate agent screen that merely narrates credential work', async () => {
    await showOnPane('pty-1', [
      '• Wired the API key into .env.example and documented it.',
      '',
      '› Ask Codex to do anything'
    ])
    const onUndelivered = vi.fn()
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: PROMPT,
      agent: 'codex',
      onUndelivered
    })
    await flushMicrotasks()
    driveCodexToReady()

    await expect(promise).resolves.toBe(true)
    expect(testState.sendRuntimePtyInputVerified).toHaveBeenCalledWith({}, 'pty-1', PASTED_PROMPT)
    expect(onUndelivered).not.toHaveBeenCalled()
  })

  it('reports a credential refusal separately from a readiness timeout', async () => {
    const onUndelivered = vi.fn()
    testState.inspectRuntimeTerminalProcess.mockResolvedValue({ foregroundProcess: 'bash' })
    const promise = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: PROMPT,
      agent: 'codex',
      timeoutMs: 1,
      onUndelivered
    })

    await expect(promise).resolves.toBe(false)
    expect(onUndelivered).toHaveBeenCalledExactlyOnceWith('readiness-timeout')
  })

  it('guards the known-PTY entry point the folder-workspace startup uses', async () => {
    await showOnPane('pty-9', SIGN_IN_DIALOG)
    const onUndelivered = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      tabId: 'tab-1',
      ptyId: 'pty-9',
      content: PROMPT,
      agent: 'codex',
      submit: true,
      onUndelivered
    })
    await flushMicrotasks()
    driveCodexToReady()

    await expect(promise).resolves.toBe(false)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
    expect(onUndelivered).toHaveBeenCalledExactlyOnceWith('credential-prompt')
  })

  it('guards the automation reuse entry point, which has no readiness wait at all', async () => {
    await showOnPane('pty-1', SIGN_IN_DIALOG)

    await expect(
      submitPromptToAgentPty({ tabId: 'tab-1', ptyId: 'pty-1', content: PROMPT })
    ).resolves.toBe(false)
    expect(testState.sendRuntimePtyInputVerified).not.toHaveBeenCalled()
  })
})
