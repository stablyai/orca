// How each call site's prompt reaches the agent: folded into argv, or pasted once the TUI is
// ready — and whether it submits. The choice is a per-agent table crossed with the delivery mode
// the call site asks for, so it is pinned along both axes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import {
  createLaunchFunnelStore,
  queuedStartupCommand,
  queuedStartupPayload,
  resetLaunchFunnelStore
} from './agent-launch-funnel-test-harness'

const store = createLaunchFunnelStore()
/** Loosely typed so the suite can read back the whole delivery request the funnel built. */
const mockPasteDraftWhenAgentReady = vi.fn<(request: Record<string, unknown>) => Promise<boolean>>(
  async () => true
)

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))

const PROMPT = 'Explain the failing check and propose a fix.'

/**
 * One agent per prompt-injection mode crossed with the delivery a call site can ask for.
 * `transport` is what the launch actually does with the text: `argv` folds it into the launch
 * command, `paste` starts the agent empty and sends it once the TUI is ready, and `env` hands it
 * over in the startup environment because the text must never appear on a command line.
 */
const TRANSPORT_TABLE: readonly {
  agent: TuiAgent
  mode: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  transport: 'argv' | 'paste' | 'env'
  submits: boolean
}[] = [
  { agent: 'codex', mode: 'argv', promptDelivery: 'auto-submit', transport: 'argv', submits: true },
  { agent: 'codex', mode: 'argv', promptDelivery: 'draft', transport: 'paste', submits: false },
  {
    agent: 'codex',
    mode: 'argv',
    promptDelivery: 'submit-after-ready',
    transport: 'paste',
    submits: true
  },
  // Claude is the argv agent with a native draft flag, so its draft rides argv instead of pasting.
  { agent: 'claude', mode: 'argv', promptDelivery: 'draft', transport: 'argv', submits: false },
  {
    agent: 'gemini',
    mode: 'flag-prompt-interactive',
    promptDelivery: 'auto-submit',
    transport: 'argv',
    submits: true
  },
  {
    agent: 'opencode',
    mode: 'flag-prompt',
    promptDelivery: 'auto-submit',
    transport: 'argv',
    submits: true
  },
  {
    agent: 'copilot',
    mode: 'flag-interactive',
    promptDelivery: 'auto-submit',
    transport: 'argv',
    submits: true
  },
  // Hermes never puts the query on a command line: it is handed over in the environment and the
  // launch command is a shell wrapper that consumes and unsets it.
  {
    agent: 'hermes',
    mode: 'hermes-query',
    promptDelivery: 'auto-submit',
    transport: 'env',
    submits: true
  },
  // A followup-path agent cannot take a prompt on its command line at all.
  {
    agent: 'amp',
    mode: 'stdin-after-start',
    promptDelivery: 'auto-submit',
    transport: 'paste',
    submits: false
  },
  {
    agent: 'amp',
    mode: 'stdin-after-start',
    promptDelivery: 'submit-after-ready',
    transport: 'paste',
    submits: true
  }
]

const cases = callerProfileCases()

async function launch(profile: AgentLaunchCallerProfile) {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  return launchAgentInNewTab({ ...profile.args })
}

describe('agent launch caller prompt transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it.each(cases)(
    'carries the prompt %s sends on the transport its mode picks',
    async (id, profile) => {
      const result = await launch(profile)

      if (profile.args.prompt === undefined) {
        expect(result?.pasteDraftAfterLaunch).toBe(false)
        expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
        expect(queuedStartupCommand(store)).not.toContain(PROMPT)
        return
      }
      // quick-command is the only prompt-carrying call site that names no delivery mode, so its text
      // rides argv; every other one asks for draft or submit-after-ready and pastes.
      const ridesArgv = id === 'quick-command'
      expect(result?.pasteDraftAfterLaunch).toBe(!ridesArgv)
      expect(queuedStartupCommand(store)?.includes(PROMPT)).toBe(ridesArgv)
    }
  )

  it.each(cases)('pins whether %s asks the pasted prompt to submit', async (_id, profile) => {
    await launch(profile)

    if (!mockPasteDraftWhenAgentReady.mock.calls.length) {
      return
    }
    expect(mockPasteDraftWhenAgentReady.mock.calls[0]?.[0]).toMatchObject({
      tabId: 'tab-1',
      content: profile.args.prompt,
      agent: profile.args.agent,
      submit: profile.args.promptDelivery === 'submit-after-ready',
      forcePaste: true
    })
  })

  it.each(cases)(
    'exposes a delivery promise to %s only for submit-after-ready',
    async (_id, profile) => {
      const result = await launch(profile)

      // Why: three call sites branch on this promise being present; a draft launch must NOT get one,
      // because the composer owns the text until the user sends it.
      const expectsPromise =
        profile.args.prompt !== undefined && profile.args.promptDelivery === 'submit-after-ready'
      expect(result?.promptDeliveryResult !== undefined).toBe(expectsPromise)
      if (expectsPromise) {
        await expect(result?.promptDeliveryResult).resolves.toEqual({
          delivered: true,
          failureNotified: false
        })
      }
    }
  )

  it.each(cases)('tells %s when its prompt was actually delivered', async (_id, profile) => {
    const onPromptDelivered = vi.fn()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ ...profile.args, onPromptDelivered })
    await result?.promptDeliveryResult

    if (profile.args.prompt === undefined) {
      expect(onPromptDelivered).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(() => expect(onPromptDelivered).toHaveBeenCalledTimes(1))
  })

  it.each(
    TRANSPORT_TABLE.map(
      (row) => [`${row.agent} (${row.mode}) on ${row.promptDelivery}`, row] as const
    )
  )('delivers a prompt to %s the way its agent supports', async (_label, row) => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: row.agent,
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: row.promptDelivery
    })

    expect(result?.pasteDraftAfterLaunch).toBe(row.transport === 'paste')
    expect(queuedStartupCommand(store)?.includes(PROMPT)).toBe(row.transport === 'argv')
    if (row.transport === 'paste') {
      expect(mockPasteDraftWhenAgentReady.mock.calls[0]?.[0]).toMatchObject({
        content: PROMPT,
        submit: row.submits
      })
    } else {
      expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
    }
    if (row.transport === 'env') {
      expect(queuedStartupPayload(store)?.env).toMatchObject({
        ORCA_HERMES_STARTUP_QUERY: PROMPT
      })
    }
  })

  it('mirrors an argv-carried draft into the chat composer', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'draft'
    })

    // Why: the draft rode in on `--prefill`, so no paste runs and nothing else would seed chat.
    expect(store.seedNativeChatLaunchDraft).toHaveBeenCalledTimes(1)
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('refuses a whitespace-only prompt rather than launching a blank agent', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: '   \n  ',
      promptDelivery: 'submit-after-ready'
    })

    expect(result?.pasteDraftAfterLaunch).toBe(false)
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('reports an undelivered submit-after-ready prompt without throwing at the caller', async () => {
    mockPasteDraftWhenAgentReady.mockResolvedValue(false)
    const onPromptDelivered = vi.fn()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      onPromptDelivered
    })

    await expect(result?.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
    expect(onPromptDelivered).not.toHaveBeenCalled()
  })
})
