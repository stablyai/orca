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
  callStructuredAgentSession: rpc
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
      settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: true }
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

  it('hides when the feature is disabled or the host offers nothing', async () => {
    rpc.mockResolvedValue({ sessions: candidates })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: false }
    })
    await mount()
    expect(screen.queryByRole('button')).toBeNull()
    // Nothing is even asked of the host while the feature is off.
    expect(rpc).not.toHaveBeenCalled()

    cleanup()
    rpc.mockResolvedValue({ sessions: [] })
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: true }
    })
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
