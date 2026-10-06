// @vitest-environment happy-dom

// Which Retry a press takes: the same message queued again on a host that can, a new copy from the
// outbox where the host cannot, and none while the host has not said which.

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  renderHook,
  screen
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubmissionRejectionFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'

const capability = vi.hoisted((): { state: 'supported' | 'unsupported' | 'unknown' } => ({
  state: 'supported'
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => capability.state
}))

const { useStructuredAgentSessionRetryInPlace } =
  await import('./use-structured-agent-session-retry-in-place')
const { structuredAgentSessionDeliveryNotices } =
  await import('./structured-agent-session-delivery-notices')
const { MessageRow } = await import('./NativeChatMessageRow')

const ID = '1759312345678-0123456789abcdef0123456789abcdef'

function rejected(
  fact: SubmissionRejectionFact,
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    submittedAt: 4,
    resolvedAt: 7,
    handoverRecorded: true,
    ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: 'Codex' }),
    ...extra
  }
}

let mutate = vi.fn()
let outboxRetry = vi.fn()

beforeEach(() => {
  mutate = vi.fn(async () => null)
  outboxRetry = vi.fn()
  capability.state = 'supported'
})

afterEach(cleanup)

function render(submissions: AgentJournalSubmission[]) {
  return renderHook(() =>
    useStructuredAgentSessionRetryInPlace({
      target: { kind: 'local' },
      mutate,
      submissions,
      outboxRetry
    })
  )
}

const QUEUE_AGAIN = [
  'agentSession.retryMessage',
  'agentSession.retryMessage',
  { clientMessageId: ID }
]

describe('a Retry press', () => {
  it.each([
    ['a failed start', rejected({ kind: 'providerStartFailed' })],
    ["Orca's fault before any agent took it", rejected({ kind: 'hostFault' })]
  ])('queues the same message again for %s, on a host that can', (_case, submission) => {
    const { result } = render([submission])
    result.current.retry(ID)
    expect(mutate).toHaveBeenCalledWith(...QUEUE_AGAIN)
    expect(outboxRetry).not.toHaveBeenCalled()
  })

  it.each([
    ['a refusal of what it says', [rejected({ kind: 'providerRejected' })]],
    ['a message an agent took', [rejected({ kind: 'hostFault' }, { handedOverAt: 6 })]],
    ['a message the journal does not hold yet', []]
  ])('sends a new copy for %s', (_case, submissions) => {
    const { result } = render(submissions)
    result.current.retry(ID)
    expect(mutate).not.toHaveBeenCalled()
    expect(outboxRetry).toHaveBeenCalledWith(ID)
  })

  it('sends a new copy on a host known not to queue it again', () => {
    capability.state = 'unsupported'
    const { result } = render([rejected({ kind: 'providerStartFailed' })])
    result.current.retry(ID)
    expect(outboxRetry).toHaveBeenCalledWith(ID)
    expect(mutate).not.toHaveBeenCalled()
    expect(result.current.retriesInPlace).toBe(false)
  })

  // A new copy sent before the answer would leave the original with a live Retry once the host
  // says it can: the same words delivered twice. Nothing is held for the answer either.
  it('takes no press while the host has not answered, and sends nothing once it has', () => {
    capability.state = 'unknown'
    const { result, rerender } = render([
      rejected({ kind: 'providerStartFailed' }),
      rejected({ kind: 'providerRejected' }, { clientMessageId: 'refused' })
    ])

    act(() => result.current.retry(ID))
    expect(mutate).not.toHaveBeenCalled()
    expect(outboxRetry).not.toHaveBeenCalled()
    // Only a message the host could queue again waits on it; a refusal sends a new copy as ever.
    expect([...result.current.retryWaitsForHost]).toEqual([ID])

    capability.state = 'supported'
    act(() => rerender())
    expect(mutate).not.toHaveBeenCalled()
    expect(result.current.retryWaitsForHost.size).toBe(0)
  })
})

describe('a Retry before the host has answered', () => {
  function Chat({ submissions }: { submissions: AgentJournalSubmission[] }) {
    const { retry, retriesInPlace, retryWaitsForHost } = useStructuredAgentSessionRetryInPlace({
      target: { kind: 'local' },
      mutate,
      submissions,
      outboxRetry
    })
    const key = agentJournalSubmissionKey(ID)
    const notices = structuredAgentSessionDeliveryNotices(
      [],
      'Codex',
      retry,
      submissions,
      [],
      new Set(),
      [],
      new Set(),
      [],
      retriesInPlace,
      retryWaitsForHost
    )
    return (
      <MessageRow
        message={{
          id: key,
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'hello' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        deliveryNotice={notices.get(key)}
      />
    )
  }

  it('is disabled until the host can queue the message again, then queues it on a press', () => {
    capability.state = 'unknown'
    const submissions = [rejected({ kind: 'providerStartFailed' })]
    const { rerender } = renderUi(<Chat submissions={submissions} />)

    const waiting = screen.getByRole('button', { name: 'Retry' })
    expect(waiting).toBeDisabled()
    expect(waiting).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(waiting)
    expect(mutate).not.toHaveBeenCalled()

    capability.state = 'supported'
    rerender(<Chat submissions={submissions} />)
    const ready = screen.getByRole('button', { name: 'Retry' })
    expect(ready).toBeEnabled()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(ready)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(...QUEUE_AGAIN)
    expect(outboxRetry).not.toHaveBeenCalled()
  })
})
