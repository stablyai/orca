// @vitest-environment happy-dom
import { memo } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'

afterEach(cleanup)
const EMPTY: readonly never[] = []

it('bounds submission work and renders only rows whose delivery notice changes at N and 10N', () => {
  for (const size of [32, 320]) {
    let stateReads = 0
    let fingerprintReads = 0
    const renders = new Map<string, number>()
    let latest: ReadonlyMap<string, NativeChatDeliveryNotice> = new Map()
    function submission(
      index: number,
      state: AgentJournalSubmission['dispatchState'],
      at = 1
    ): AgentJournalSubmission {
      const id = String(index)
      return {
        clientMessageId: id,
        fence: 1,
        get payloadFingerprint() {
          fingerprintReads++
          return id
        },
        get dispatchState() {
          stateReads++
          return state
        },
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: state === 'pending' ? null : at
      }
    }
    const Row = memo(function Row({
      id,
      notice
    }: {
      id: string
      notice: NativeChatDeliveryNotice | undefined
    }) {
      renders.set(id, (renders.get(id) ?? 0) + 1)
      return <span>{notice?.sending ? 'Sending' : 'Ordinary'}</span>
    })
    function Chat({ submissions }: { submissions: readonly AgentJournalSubmission[] }) {
      latest = useStructuredAgentSessionDeliveryNotices({
        pending: EMPTY,
        submissions,
        journalItems: EMPTY,
        startFailures: EMPTY,
        agentName: 'Claude'
      })
      return submissions.map(({ clientMessageId }) => (
        <Row
          key={clientMessageId}
          id={clientMessageId}
          notice={latest.get(agentJournalSubmissionKey(clientMessageId))}
        />
      ))
    }
    const initial = Array.from({ length: size }, (_, index) =>
      submission(index, index === size - 1 ? 'accepted' : 'pending')
    )
    const view = render(<Chat submissions={initial} />)
    const before = latest
    renders.clear()
    stateReads = 0
    fingerprintReads = 0
    const unrelated = [...initial.slice(0, -1), submission(size - 1, 'accepted', 2)]
    view.rerender(<Chat submissions={unrelated} />)
    expect(latest).toBe(before)
    expect(renders.size).toBe(0)
    expect(stateReads).toBeLessThanOrEqual(5 * size)
    expect(stateReads).toBeGreaterThanOrEqual(size)
    expect(fingerprintReads).toBe(0)

    stateReads = 0
    const accepted = [submission(0, 'accepted'), ...unrelated.slice(1)]
    view.rerender(<Chat submissions={accepted} />)
    expect(latest.has(agentJournalSubmissionKey('0'))).toBe(false)
    expect(latest.get(agentJournalSubmissionKey('1'))).toBe(
      before.get(agentJournalSubmissionKey('1'))
    )
    expect(renders).toEqual(new Map([['0', 1]]))
    expect(stateReads).toBeLessThanOrEqual(5 * size)
    expect(fingerprintReads).toBe(0)
    view.unmount()
  }
})
