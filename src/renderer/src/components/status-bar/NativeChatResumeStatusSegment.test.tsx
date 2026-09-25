// @vitest-environment happy-dom

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
import { _resetNativeChatRestartOffer } from '../native-chat-resume-on-restart-store'
import { NativeChatResumeStatusSegment } from './NativeChatResumeStatusSegment'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const candidates: ResumeCandidate[] = [
  {
    sessionId: 'a',
    workspaceId: 'workspace',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'Fix it',
    recordedAt: 1
  },
  {
    sessionId: 'b',
    workspaceId: 'workspace',
    agent: 'claude',
    trigger: 'update',
    latestPrompt: 'Review it',
    recordedAt: 2
  }
]

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
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('shows the host count and reopens the dialog on a fresh read', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    await mount()

    expect(screen.getByRole('button', { name: '2 chats available to resume' })).toBeTruthy()
    expect(screen.getByText('2 chats to resume')).toBeTruthy()

    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
    await act(async () => screen.getByRole('button').click())
    // The launch read, then a second one taken before the dialog is allowed to reopen.
    expect(rpc.mock.calls.map((call) => call[1])).toEqual([
      'agentSession.restartResumable',
      'agentSession.restartResumable'
    ])
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
  })

  // The offer is spent once acted on, so without this entry a failed resume would leave the bar
  // empty seconds after the toast went. The two are different facts and stay two entries.
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
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(true)
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

    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
    await act(async () => screen.getByRole('button').click())
    expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
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

  describe('with Chat UI off', () => {
    const priorApi = window.api
    const hasLocalStructuredAgentSessions = vi.fn()

    beforeEach(() => {
      hasLocalStructuredAgentSessions.mockReset()
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ...priorApi, app: { ...priorApi?.app, hasLocalStructuredAgentSessions } }
      })
      useAppStore.setState({
        settings: { ...getDefaultSettings(''), experimentalNativeChat: false }
      })
    })

    afterEach(() => {
      Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
    })

    it('offers chats that were working when the host holds structured chats', async () => {
      hasLocalStructuredAgentSessions.mockResolvedValue(true)
      rpc.mockResolvedValue({ sessions: candidates })
      await mount()

      expect(screen.getByRole('button', { name: '2 chats available to resume' })).toBeTruthy()
    })

    it('never asks the host, or starts it, when there is no structured chat', async () => {
      hasLocalStructuredAgentSessions.mockResolvedValue(false)
      rpc.mockResolvedValue({ sessions: candidates })
      await mount()

      expect(hasLocalStructuredAgentSessions).toHaveBeenCalledOnce()
      expect(rpc).not.toHaveBeenCalled()
      expect(screen.queryByRole('button')).toBeNull()
    })
  })

  it('waits for settings, which carry the resume preference, before asking the host', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({ settings: null })
    await mount()

    expect(rpc).not.toHaveBeenCalled()
    await act(async () => {
      useAppStore.setState({ settings: getDefaultSettings('') })
    })
    expect(rpc).toHaveBeenCalledWith(expect.anything(), 'agentSession.restartResumable')
  })

  it('hides when the host offers nothing', async () => {
    rpc.mockResolvedValue({ sessions: [] })
    await mount()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a compact count in icon-only mode', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    await mount(true)

    expect(screen.getByRole('button').textContent).toContain('2')
    expect(screen.queryByText('2 chats to resume')).toBeNull()
  })
})
