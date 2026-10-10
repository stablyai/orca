// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import {
  createResumeModalFixture,
  offered,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'
import { getNativeChatRestartOffer } from './native-chat-resume-on-restart-store'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: ResumeStatusStream['emit']
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const { mount, button, toasts, runStatus } = createResumeModalFixture(rpc, statusStream)
const dialog = () => document.querySelector('[role="dialog"]')?.textContent

function emitPhase(phase?: NonNullable<AgentSessionStatusSummary['restartResume']>['phase']) {
  statusStream.emit({
    type: 'status',
    session: {
      sessionId: 'a',
      workspaceId: 'workspace',
      agent: 'codex',
      status: 'idle',
      latestPrompt: '',
      updatedAt: 1,
      ...(phase ? { restartResume: { phase } } : {})
    }
  })
}

it.each(['received', 'missed'] as const)(
  "resumes 1 of 1 after another action's skip when real progress frames are %s",
  async (frames) => {
    const reply = Promise.withResolvers<unknown>()
    rpc.mockImplementation(async (_target, method) =>
      method === 'agentSession.restartResumable'
        ? { sessions: [offered[0]], failed: [] }
        : reply.promise
    )
    await mount(
      <>
        <NativeChatResumeOnRestartModal />
        <NativeChatResumeStatusSegment iconOnly={false} />
      </>
    )
    await act(async () => button('Resume 1 chat').click())
    await act(async () => emitPhase('skipped'))
    await act(async () => button('Resuming chats 0/0').click())
    expect(dialog()).not.toContain('Prompt a')
    if (frames === 'received') {
      await act(async () => emitPhase('queued'))
      expect(button('Resuming chats 0/1')).toBeTruthy()
      expect(runStatus('Prompt a')).toMatch(/Waiting to start/)
      await act(async () => {
        emitPhase('starting')
        emitPhase('continued')
        emitPhase()
      })
      expect(button('Resuming chats 1/1')).toBeTruthy()
      expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    }
    await act(async () =>
      reply.resolve({
        sessions: [],
        failed: [],
        continued: [{ sessionId: 'a', outcome: 'continued' }]
      })
    )
    expect(dialog()).toContain('Resumed 1 of 1 chat')
    expect(dialog()).toContain('All1')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(toasts()).toEqual([['Resumed 1 chat']])
  }
)

it.each(['returned', 'lost'] as const)(
  'keeps current failure rows and counts after a skipped retry with a %s reply',
  async (delivery) => {
    const reply = Promise.withResolvers<unknown>()
    const initial = [
      { ...failure('a', 'agent_session_conflict'), retryable: true },
      { ...failure('b'), outcome: 'unconfirmed' as const }
    ]
    const reconciled = [{ ...initial[0], retryable: false }, initial[1]]
    let reads = 0
    rpc.mockImplementation(async (_target, method) =>
      method === 'agentSession.restartContinue'
        ? reply.promise
        : { sessions: [], failed: reads++ === 0 ? initial : reconciled }
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await mount(
        <>
          <NativeChatResumeOnRestartModal />
          <NativeChatResumeStatusSegment iconOnly={false} />
        </>
      )
      await act(async () => requestNativeChatResumeOnRestartDialog())
      await act(async () => button('Retry').click())
      await act(async () => {
        emitPhase('skipped')
        emitPhase()
      })
      await act(async () => {
        if (delivery === 'lost') {
          reply.reject(new Error('lost reply after skipped retry'))
        } else {
          reply.resolve({ sessions: [], failed: reconciled, skipped: ['a'], continued: [] })
        }
      })
      expect(getNativeChatRestartOffer().failed.map((row) => row.sessionId)).toEqual(['a', 'b'])
      expect(dialog()).toContain('Prompt a')
      expect(dialog()).toContain('Prompt b')
      expect(dialog()).toContain('All2')
      expect(dialog()).toContain('Need you2')
      expect(dialog()).toContain(
        delivery === 'lost' ? 'Resumed 0 of 1 chat' : 'Resumed 0 of 0 chats'
      )
      expect(button('2 chats to check')).toBeTruthy()
      expect(
        [...document.querySelectorAll('button')].filter(
          (entry) => entry.textContent === 'Open chat'
        )
      ).toHaveLength(2)
      expect(document.querySelectorAll('button[aria-label^="Dismiss"]')).toHaveLength(2)
      expect(runStatus('Prompt a')).toBe('Prompt a: Couldn’t resume')
      if (delivery === 'lost') {
        expect(toasts()).toEqual([['1 chat couldn’t be resumed']])
      }
    } finally {
      warn.mockRestore()
    }
  }
)
