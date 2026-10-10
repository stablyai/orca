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
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { chatBox } from './native-chat-resume-on-restart-modal.test-support'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'
import {
  continueNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
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
vi.mock('sonner', () => ({ toast: vi.fn() }))

const { mount, button, offerIds, toasts, fakeHost, runStatus } = createResumeModalFixture(
  rpc,
  statusStream
)

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

it('resumes a 21-chat selection with one action and no redundant listing', async () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    ...offered[0]!,
    sessionId: `chat-${index}`
  }))
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: candidates, failed: [] }
      : {
          sessions: [],
          failed: [],
          continued: candidates.map(({ sessionId }) => ({ sessionId, outcome: 'continued' }))
        }
  )
  await refreshNativeChatRestartOffer()
  await continueNativeChatRestartOffer(candidates.map(({ sessionId }) => sessionId))
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: candidates.map(({ sessionId }) => sessionId) }]
  ])
  expect(toasts()).toEqual([['Resumed 21 chats']])
})

it('uses the host unconfirmed result after a lost bulk reply without reporting a failure', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let reads = 0
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartContinue') {
      throw new Error('reply lost')
    }
    return reads++ === 0
      ? { sessions: offered, failed: [] }
      : {
          sessions: [],
          failed: [
            { ...failure('a'), outcome: 'unconfirmed' },
            { ...failure('b'), outcome: 'unconfirmed' }
          ]
        }
  })
  try {
    await refreshNativeChatRestartOffer()
    await continueNativeChatRestartOffer(['a', 'b'])
    expect(toasts()).toEqual([['Couldn’t confirm 2 chats were resumed']])
    expect(getNativeChatRestartOffer().failed.map((row) => row.outcome)).toEqual([
      'unconfirmed',
      'unconfirmed'
    ])
  } finally {
    warn.mockRestore()
  }
})

it('publishes a refusal reply without needing a second host read', async () => {
  let reads = 0
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      if (reads++ > 0) {
        throw new Error('listing unavailable')
      }
      return { sessions: offered, failed: [] }
    }
    return {
      sessions: [offered[1]],
      failed: [failure('a')],
      continued: [{ sessionId: 'a', outcome: 'refused' }]
    }
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => chatBox('b').click())
  await act(async () => button('Resume 1 chat').click())
  expect(reads).toBe(1)
  expect(offerIds()).toEqual(['b'])
  expect(getNativeChatRestartOffer().failed.map((row) => row.sessionId)).toEqual(['a'])
  expect(toasts()).toEqual([['1 chat couldn’t be resumed']])
})

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

it('removes a skipped selection from pending rows and all progress counts', async () => {
  const host = fakeHost({}, (sessionId) => (sessionId === 'a' ? 'skipped' : 'continued'))
  host.hold('b')
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  host.state.sessions = host.state.sessions.filter((row) => row.sessionId !== 'a')
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/1').click())
  const dialog = () => document.querySelector('[role="dialog"]')?.textContent
  expect(dialog()).not.toContain('Prompt a')
  expect(dialog()).toContain('All1')
  expect(dialog()).toContain('0 of 1 done')
  expect(dialog()).toContain('In progress1')
  await host.release('b')
  expect(dialog()).toContain('Resumed 1 of 1 chat')
  expect(dialog()).toContain('1 of 1 done')
  expect(dialog()).toContain('All1')
  expect(dialog()).toContain('In progress0')
  expect(runStatus('Prompt b')).toBe('Prompt b: Resumed')
  expect(toasts()).toEqual([['Resumed 1 chat']])
})

it('uses reply skipped ids even when the skip frame was missed', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: offered, failed: [] }
      : {
          sessions: [],
          failed: [],
          skipped: ['b'],
          continued: [{ sessionId: 'a', outcome: 'continued' }]
        }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => continueNativeChatRestartOffer(['a', 'b']))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 1 of 1 chat')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('All1')
  expect(runStatus('Prompt b')).toBeNull()
})

it.each(['unknown', 'pending'] as const)(
  'reconciles %s with the reply failure list for both dialog and toast',
  async (outcome) => {
    rpc.mockImplementation(async (_target, method) =>
      method === 'agentSession.restartResumable'
        ? { sessions: [offered[0]], failed: [] }
        : { sessions: [], failed: [], continued: [{ sessionId: 'a', outcome }] }
    )
    await mount(<NativeChatResumeOnRestartModal />)
    await act(async () => continueNativeChatRestartOffer(['a']))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 1 of 1 chat')
    expect(runStatus('Prompt a')).toBe('Prompt a: Resumed')
    expect(toasts()).toEqual([['Resumed 1 chat']])
  }
)

it('dismissing a failure after the reply never promotes it to resumed history', async () => {
  fakeHost({ sessions: [offered[0]!] }, () => 'unknown')
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => continueNativeChatRestartOffer(['a']))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 0 of 1 chat')
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')
  expect(dismiss).not.toBeNull()
  await act(async () => dismiss?.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 0 of 1 chat')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you0')
  expect(runStatus('Prompt a')).toBeNull()
  expect(toasts()).toEqual([['Couldn’t confirm 1 chat was resumed']])
})

it('keeps an unknown reply unconfirmed when it carries no confirmed failure list', async () => {
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: [offered[0]], failed: [] }
      : { sessions: [], continued: [{ sessionId: 'a', outcome: 'unknown' }] }
  )
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => continueNativeChatRestartOffer(['a']))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resumed 0 of 1 chat')
  expect(runStatus('Prompt a')).toBeNull()
  expect(toasts()).toEqual([['Couldn’t confirm 1 chat was resumed']])
})

it('a retry hides its old failure, then a dismissed final failure leaves Need you', async () => {
  const host = fakeHost(
    { sessions: [], failed: [failure('b', 'agent_session_conflict')] },
    () => 'refused',
    'agent_session_conflict'
  )
  host.hold('b')
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  await act(async () => button('Retry').click())
  expect(runStatus('Prompt b')).toMatch(/Waiting to start/)
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Another Orca')
  expect(document.querySelector('[aria-label*="Couldn’t resume"]')).toBeNull()
  await host.release('b')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you1')
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')
  expect(dismiss).not.toBeNull()
  await act(async () => dismiss?.click())
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you0')
  expect(runStatus('Prompt b')).toBeNull()
})
