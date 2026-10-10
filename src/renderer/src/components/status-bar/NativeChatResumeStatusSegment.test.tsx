// @vitest-environment happy-dom

import { resetLocalStructuredChatsForTests } from '@/runtime/local-structured-chats'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import type { ResumeCandidate } from '../native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from '../native-chat-resume-on-restart-dialog'
import { _resetNativeChatRestartOffer } from '../native-chat-restart-offer-triggers'
import { NativeChatResumeStatusSegment } from './NativeChatResumeStatusSegment'
import { nativeChatResumePendingText } from './native-chat-resume-status-text'
import { readNativeChatRestartMachine } from '../native-chat-resume-on-restart-store'
import { pairedEnvironment } from '../native-chat-restart-offer-test-support'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  pairedRestartOffersSupport: async () => 'supported',
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }))

const candidates: ResumeCandidate[] = [
  {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'Fix it',
    recordedAt: 1,
    origin: 'own'
  },
  {
    sessionId: 'b',
    workspaceId: 'workspace',
    agent: 'claude',
    trigger: 'update',
    latestPrompt: 'Review it',
    recordedAt: 2,
    origin: 'own'
  }
]

/** Whether this machine's runtime reports a structured host, as the desktop bridge answers it. */
function stageLocalHost(installed: boolean): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        holdsStructuredAgentSessions: async () => installed,
        onStructuredAgentSessionsHeldChanged: () => () => undefined
      }
    }
  })
}

/** Mounts the segment and snoozes the launch dialog the offer raises, as the modal's close does. */
async function mount(iconOnly = false): Promise<void> {
  await act(async () => {
    render(
      <TooltipProvider>
        <NativeChatResumeStatusSegment iconOnly={iconOnly} />
      </TooltipProvider>
    )
  })
  act(() => consumeNativeChatResumeOnRestartDialogRequest())
}

describe('NativeChatResumeStatusSegment', () => {
  beforeEach(() => {
    rpc.mockReset()
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      settings: { ...getDefaultSettings(''), experimentalNativeChat: true }
    })
  })

  afterEach(() => {
    cleanup()
    resetLocalStructuredChatsForTests()
    Reflect.deleteProperty(window, 'api')
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('shows the host count and reopens the dialog on a fresh read', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    await mount()

    expect(screen.getByRole('button', { name: '2 chats available to resume' })).toBeTruthy()
    expect(screen.getByText('2 chats to resume')).toBeTruthy()

    expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
    await act(async () => screen.getByRole('button').click())
    // The launch read, then a second one taken before the dialog is allowed to reopen.
    expect(rpc.mock.calls.map((call) => call[1])).toEqual([
      'agentSession.restartResumable',
      'agentSession.restartResumable'
    ])
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: 'local' })
  })

  // The offer is spent once acted on, so this entry is the one summary a failed resume leaves.
  // The two are different facts and stay two entries.
  it('keeps a failed resume as its own entry beside any remaining offer', async () => {
    const failed = {
      ...candidates[0]!,
      failedAt: 60_000,
      outcome: 'refused',
      reason: 'agent_session_restart_work_superseded'
    }
    rpc.mockResolvedValue({ sessions: candidates.slice(1), failed: [failed] })
    await mount()

    expect(screen.getByText('1 chat to resume')).toBeTruthy()
    const entry = screen.getByRole('button', {
      name: '1 chat failed to resume. Click for details.'
    })
    expect(entry.textContent).toBe('1 chat failed to resume')

    rpc.mockResolvedValue({ sessions: [], failed: [failed] })
    await act(async () => entry.click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: 'local' })
    // With the offer gone, only the failure entry is left — and it stays.
    expect(screen.queryByText('1 chat to resume')).toBeNull()
    expect(screen.getByText('1 chat failed to resume')).toBeTruthy()
  })

  // The agent may be working on an unconfirmed one, so the entry must not call it failed — the
  // dialog says "couldn't confirm" for that row, and "failed" would invite a second "continue".
  it('does not call an unconfirmed resume failed', async () => {
    const failure = (sessionId: 'a' | 'b', outcome: 'refused' | 'unconfirmed') => ({
      ...candidates.find((entry) => entry.sessionId === sessionId)!,
      failedAt: 60_000,
      outcome,
      reason: outcome === 'refused' ? 'agent_session_restart_work_superseded' : 'pending'
    })
    rpc.mockResolvedValue({
      sessions: [],
      failed: [failure('a', 'refused'), failure('b', 'unconfirmed')]
    })
    await mount()

    expect(
      screen.getByRole('button', { name: '2 chats to check after resuming. Click for details.' })
        .textContent
    ).toBe('2 chats to check')
    expect(screen.queryByText(/failed to resume/)).toBeNull()
  })

  it('names a single chat in the singular', async () => {
    rpc.mockResolvedValue({ sessions: candidates.slice(0, 1) })
    await mount()

    expect(screen.getByRole('button', { name: '1 chat available to resume' })).toBeTruthy()
    expect(screen.getByText('1 chat to resume')).toBeTruthy()
  })

  // The count can lag the host — another window may have dismissed the offer. The re-read decides.
  it('does not reopen the dialog when the host no longer offers anything', async () => {
    rpc.mockResolvedValueOnce({ sessions: candidates }).mockResolvedValue({ sessions: [] })
    await mount()

    expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
    await act(async () => screen.getByRole('button').click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('retries a transient host startup read before hiding a durable offer', async () => {
    rpc
      .mockRejectedValueOnce(new Error('host-starting'))
      .mockResolvedValue({ sessions: candidates })
    await mount()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 125)))

    expect(screen.getByRole('button', { name: '2 chats available to resume' })).toBeTruthy()
    expect(rpc.mock.calls.map((call) => call[1])).toEqual([
      'agentSession.restartResumable',
      'agentSession.restartResumable'
    ])
  })

  it('hides when no chat exists and the setting is off, or the host offers nothing', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalNativeChat: false }
    })
    await mount()
    expect(screen.queryByRole('button')).toBeNull()
    // A machine with no structured chat and the setting off asks the host nothing.
    expect(rpc).not.toHaveBeenCalled()

    cleanup()
    rpc.mockResolvedValue({ sessions: [] })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalNativeChat: true }
    })
    await mount()
    expect(screen.queryByRole('button')).toBeNull()
  })

  // The setting picks what new agents open as; chats that already exist keep their offer.
  it('offers to continue the chats this machine holds while the setting is off', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalNativeChat: false }
    })
    stageLocalHost(true)
    await mount()

    expect(rpc).toHaveBeenCalledWith(expect.anything(), 'agentSession.restartResumable')
    expect(screen.getByRole('button')).toBeTruthy()
  })

  // The offer is this machine's runtime's; a paired server's chats are no reason to build it.
  it("does not ask this machine for an offer over a paired server's chats", async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalNativeChat: false },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'agent-session:claude_1',
            entityId: 'claude_1',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            executionHostId: 'runtime:server-1',
            contentType: 'agent-session',
            agentSessionAgent: 'claude',
            label: 'Claude Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    stageLocalHost(false)
    await mount()

    expect(rpc).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a compact count in icon-only mode', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    await mount(true)

    expect(screen.getByRole('button').textContent).toContain('2')
    expect(screen.queryByText('2 chats to resume')).toBeNull()
  })

  // One entry across machines: it names the machine only when there is just one.
  it('names a paired server when it is the only machine with chats, and opens on it', async () => {
    rpc.mockImplementation(async (target) =>
      target.kind === 'environment' ? { sessions: candidates } : { sessions: [] }
    )
    useAppStore.setState({
      runtimeEnvironments: [pairedEnvironment('studio', 'studio-mac')]
    })
    await mount()
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId: 'studio' })
    })
    expect(screen.getByText('2 chats to resume on studio-mac')).toBeTruthy()
    await act(async () => screen.getByRole('button').click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: 'environment:studio' })
  })

  // Another device's or an automation's chats are theirs to resume; the entry counts the user's.
  it("counts only the user's own chats, and adds nothing for a server holding only others'", async () => {
    const others = (['other-device', 'automation', 'server-made'] as const).map(
      (origin, index) => ({
        ...candidates[0]!,
        sessionId: `o${index}`,
        origin
      })
    )
    let studio = [...candidates, ...others]
    rpc.mockImplementation(async (target) =>
      target.kind === 'environment' ? { sessions: studio } : { sessions: [] }
    )
    useAppStore.setState({
      runtimeEnvironments: [pairedEnvironment('studio', 'studio-mac')]
    })
    await mount()
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId: 'studio' })
    })
    expect(screen.getByText('2 chats to resume on studio-mac')).toBeTruthy()
    studio = others
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId: 'studio' })
    })
    expect(screen.queryByRole('button')).toBeNull()
  })

  // A server's provider refused to carry the user's chat on: the entry says so, counting only the
  // user's own failures, and opens on that server. The failed label names no machine; the dialog does.
  it('counts only the user’s own failures on a paired server, and opens on it', async () => {
    const failure = (sessionId: string, origin: 'own' | 'other-device') => ({
      ...candidates[0]!,
      sessionId,
      origin,
      failedAt: 60_000,
      outcome: 'refused',
      reason: 'provider_refused_continuation'
    })
    rpc.mockImplementation(async (target) =>
      target.kind === 'environment'
        ? { sessions: [], failed: [failure('a', 'own'), failure('o', 'other-device')] }
        : { sessions: [] }
    )
    useAppStore.setState({
      runtimeEnvironments: [pairedEnvironment('studio', 'studio-mac')]
    })
    await mount()
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId: 'studio' })
    })
    const entry = screen.getByRole('button', {
      name: '1 chat failed to resume. Click for details.'
    })
    expect(entry.textContent).toBe('1 chat failed to resume')
    await act(async () => entry.click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: 'environment:studio' })
  })

  it('counts every machine in one entry and opens on none in particular', async () => {
    rpc.mockImplementation(async (target) =>
      target.kind === 'environment' ? { sessions: candidates } : { sessions: [candidates[0]] }
    )
    useAppStore.setState({
      runtimeEnvironments: [pairedEnvironment('studio', 'studio-mac')]
    })
    await mount()
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId: 'studio' })
    })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('3 chats to resume')).toBeTruthy()
    await act(async () => screen.getByRole('button').click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: null })
  })

  it('breaks the tooltip down by machine only when there is more than one', () => {
    expect(
      nativeChatResumePendingText(4, null, [
        { count: 1, name: 'Local Mac' },
        { count: 2, name: 'studio-mac' },
        { count: 1, name: 'build-box' }
      ]).tooltip
    ).toBe('4 chats to resume: 1 on Local Mac, 2 on studio-mac, 1 on build-box. Click to choose.')
    expect(
      nativeChatResumePendingText(2, 'studio-mac', [{ count: 2, name: 'studio-mac' }])
    ).toEqual({
      label: '2 chats to resume on studio-mac',
      ariaLabel: '2 chats available to resume',
      tooltip: 'Open interrupted chats available to resume'
    })
    expect(nativeChatResumePendingText(1, null, [{ count: 1, name: 'Local Mac' }]).label).toBe(
      '1 chat to resume'
    )
  })

  // Read first, as this computer's entry always has; a server out of contact is not waited on.
  it('re-reads this computer and opens over a disconnected server’s last listing', async () => {
    let hang = false
    rpc.mockImplementation((target) => {
      if (hang && target.kind === 'environment') {
        // An unreachable server: a re-read would never answer.
        return new Promise(() => {})
      }
      return Promise.resolve({ sessions: candidates })
    })
    useAppStore.setState({
      runtimeEnvironments: [pairedEnvironment('studio', 'studio-mac')]
    })
    await mount()
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId: 'studio' })
    })
    hang = true
    await act(async () => screen.getByRole('button').click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toEqual({ focus: null })
    // This computer was asked again; the server, with no connection, was not.
    expect(
      rpc.mock.calls
        .filter((call) => call[1] === 'agentSession.restartResumable')
        .map((call) => call[0].kind)
    ).toEqual(['local', 'environment', 'local'])
  })

  // A failed re-read is loss of contact, never evidence the offers are gone: keep the last answer.
  it('keeps the last answer when a refresh of this computer fails', async () => {
    rpc.mockResolvedValueOnce({ sessions: candidates }).mockRejectedValue(new Error('host busy'))
    await mount()
    expect(screen.getByText('2 chats to resume')).toBeTruthy()
    await act(async () => {
      await readNativeChatRestartMachine({ kind: 'local' })
    })
    expect(screen.getByText('2 chats to resume')).toBeTruthy()
  })
})
