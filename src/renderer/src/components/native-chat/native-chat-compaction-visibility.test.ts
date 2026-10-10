import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { nativeChatTurnMembership } from '../../../../shared/native-chat-turn-membership'
import { selectNativeChatTurnStatuses } from '../../../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { z } from 'zod'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { isAdmissibleAgentJournalRenderItem } from '../../../../shared/agent-session-journal-schemas'
import { isAdmissibleAgentJournalSubmission } from '../../../../shared/agent-session-journal-submission-schema'

type CapturedJournal = { items: AgentJournalRenderItem[]; submissions: AgentJournalSubmission[] }

async function capturedCompaction(
  transform: (journal: CapturedJournal) => CapturedJournal = (journal) => journal
) {
  const text = await readFile(
    new URL('../../../../main/acp/fixtures/omp-v17-compact-skip.render.jsonl', import.meta.url),
    'utf8'
  )
  const captured = z
    .object({
      items: z.array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)),
      submissions: z.array(z.custom<AgentJournalSubmission>(isAdmissibleAgentJournalSubmission))
    })
    .parse(JSON.parse(text))
  const journal = transform(captured)
  const messages = projectStructuredAgentSessionMessages(journal.items, [], journal.submissions)
  const membership = nativeChatTurnMembership(messages, journal)
  const turnStatuses = selectNativeChatTurnStatuses(
    {},
    {
      activeTurnKey: membership.liveTurnKey ?? '',
      isWorking: false,
      thinking: false,
      settledByTurn: selectStructuredAgentSettledTurns(journal.items, journal.submissions)
    }
  )
  return { messages, membership, turnStatuses }
}

function slotsFor({
  messages,
  membership,
  turnStatuses
}: Awaited<ReturnType<typeof capturedCompaction>>) {
  return buildNativeChatTranscriptSlots({
    messages,
    ...membership,
    receipts: new Map(),
    turnStatuses,
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
}

describe('captured OMP compaction visibility', () => {
  it('keeps the saved skipped outcome visible after the command settles and reloads', async () => {
    const { messages, membership, turnStatuses } = await capturedCompaction()
    const command = messages.find((message) => message.command?.name === 'compact')
    const warning = messages.find((message) => message.role === 'system')
    expect(command).toBeDefined()
    expect(warning?.blocks).toEqual([
      {
        type: 'text',
        tone: 'warning',
        text: 'Nothing to compact (session too small)',
        presentation: 'compaction-skipped'
      }
    ])
    expect(membership.turnKeys).toEqual([command?.id, command?.id])
    expect(turnStatuses.completedByTurn[command?.id ?? '']).toMatchObject({
      workedSeconds: 0,
      verdict: 'success'
    })
    const slots = slotsFor({ messages, membership, turnStatuses })
    expect(
      slots.find((slot) => slot.kind === 'message' && slot.message.id === warning?.id)
    ).toMatchObject({ drawsMessage: true, folded: false, turnFolds: false })
  })

  it('keeps the saved warning visible when paging omits its command opener and submission', async () => {
    const captured = await capturedCompaction((journal) => ({
      items: journal.items.filter((item) => item.body.kind !== 'message'),
      submissions: []
    }))
    expect(captured.messages.some((message) => message.command)).toBe(false)
    expect(captured.membership.turnKeys).toEqual(['orca:command-turn%3Acompact-1'])
    expect(slotsFor(captured)[0]).toMatchObject({
      drawsMessage: true,
      folded: false,
      statusAbove: true,
      turnFolds: false
    })
  })

  it('keeps a newly marked outcome visible without an opener or a legacy identity', async () => {
    const captured = await capturedCompaction((journal) => ({
      items: journal.items
        .filter((item) => item.body.kind !== 'message')
        .map((item) =>
          item.body.kind === 'status'
            ? {
                ...item,
                itemId: 'orca:future-outcome',
                body: { ...item.body, presentation: 'compaction-skipped' }
              }
            : item
        ),
      submissions: []
    }))
    expect(slotsFor(captured)[0]).toMatchObject({ drawsMessage: true, folded: false })
  })

  it.each([
    'orca:ordinary-warning',
    'legacy:grok:runtime-session-1:item%3Ap%3Asession-1%3Acompaction%253Acompact%253Acompact-1'
  ])('continues folding an ordinary warning beside a compact command: %s', async (itemId) => {
    const captured = await capturedCompaction((journal) => ({
      ...journal,
      items: journal.items.map((item) => (item.body.kind === 'status' ? { ...item, itemId } : item))
    }))
    const slots = slotsFor(captured)
    expect(slots.map((slot) => slot.kind === 'message' && slot.message.role)).toEqual(['user'])
    expect(slots[0]).toMatchObject({ turnFolds: true })
  })

  it('preserves an unknown presentation instead of reclassifying its warning', async () => {
    const captured = await capturedCompaction((journal) => ({
      ...journal,
      items: journal.items.map((item) =>
        item.body.kind === 'status'
          ? { ...item, body: { ...item.body, presentation: 'future-presentation' } }
          : item
      )
    }))
    expect(captured.messages[1]?.blocks[0]).toMatchObject({ presentation: 'future-presentation' })
    expect(slotsFor(captured)).toHaveLength(1)
  })
})
