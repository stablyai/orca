// @vitest-environment happy-dom
import {
  createResumeModalFixture,
  offered,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from '../NativeChatResumeRuntimeModal'

import { NativeChatResumeStatusSegment } from '../../status-bar/NativeChatResumeStatusSegment'
import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import type { AgentSessionStatusSummary } from '../../../../../shared/agent-session/agent-session-wire'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc
}))

vi.mock('../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: (event: Parameters<ResumeStatusStream['emit']>[0]) => void
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', async () =>
  (await import('./native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)

const { mount, button, offerIds, runStatus } = createResumeModalFixture(rpc, statusStream)

function emitPhase(
  sessionId: string,
  phase?: NonNullable<AgentSessionStatusSummary['restartResume']>['phase']
): void {
  statusStream.emit({
    type: 'status',
    session: {
      sessionId,
      workspaceId: 'workspace',
      agent: 'codex',
      status: 'idle',
      latestPrompt: '',
      updatedAt: 1,
      ...(phase ? { restartResume: { phase } } : {})
    }
  })
}

it('keeps the run in flight after every feed verdict until the fallback list is published', async () => {
  const answer = Promise.withResolvers<{
    continued: { sessionId: string; outcome: 'continued' }[]
  }>()
  const listing = Promise.withResolvers<{ sessions: ResumeCandidate[]; failed: ResumeFailure[] }>()
  let reads = 0
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartContinue'
      ? answer.promise
      : reads++ === 0
        ? { sessions: offered, failed: [] }
        : listing.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await act(async () => {
    for (const { sessionId } of offered) {
      statusStream.emit({
        type: 'status',
        session: {
          sessionId,
          workspaceId: 'workspace',
          agent: 'codex',
          status: 'idle',
          latestPrompt: '',
          updatedAt: 1,
          restartResume: { phase: 'continued' }
        }
      })
    }
    answer.resolve({
      continued: offered.map(({ sessionId }) => ({ sessionId, outcome: 'continued' }))
    })
  })
  expect(button('Resuming chats 2/2')).toBeTruthy()
  await act(async () => offered.forEach(({ sessionId }) => emitPhase(sessionId)))
  expect(button('Resuming chats 2/2')).toBeTruthy()
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(button('Resuming…').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('chats to resume')
  await act(async () => listing.resolve({ sessions: [], failed: [] }))
  expect(offerIds()).toEqual([])
  expect(button('Done').disabled).toBe(false)
  expect(document.body.textContent).not.toContain('Resuming chats')
})

it('retains success and refusal frames through cleanup before a delayed bulk reply', async () => {
  const reply = Promise.withResolvers<unknown>()
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable' ? { sessions: offered, failed: [] } : reply.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  // Verdicts and cleanup can arrive together before React gets a render.
  await act(async () => {
    emitPhase('a', 'continued')
    emitPhase('b', 'refused')
    emitPhase('a')
    emitPhase('b')
  })
  expect(button('Resuming chats 2/2')).toBeTruthy()
  await act(async () => button('Resuming chats 2/2').click())
  expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
  expect(runStatus('Prompt b')).toBe('Prompt b: Couldn’t resume')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you1')
  await act(async () =>
    reply.resolve({
      sessions: [],
      failed: [failure('b')],
      continued: [
        { sessionId: 'a', outcome: 'continued' },
        { sessionId: 'b', outcome: 'refused' }
      ]
    })
  )
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 1 of 2 chats')
})
