import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'
import { projectStructuredItemToNativeChat } from './view/structured-agent-session-projection'
import type { AgentSessionHistoryPage } from './agent-session-wire'
import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'
import { describe, expect, it } from 'vitest'
import type { AgentMessageSource } from './agent-session-message-source'
import { mailReportPresentation } from './mail-report-presentation'
import {
  readMailDisplayReport,
  applyMailDisplayProjection,
  mailDisplayReportsForItem
} from './mail-display-report'
import { projectQueuedMessageCards } from './view/structured-agent-session-queued-cards'

const source = (address: string, agent?: string): AgentMessageSource => ({
  kind: 'agent',
  senders: [
    {
      party: { address, terminalHandle: address, orcaSessionId: null },
      name: 'Setup',
      ...(agent ? { agent } : {})
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'run:receiver',
    dispatchId: null,
    messages: [{ messageId: 'mail-1', runId: 'run-1', from: address }]
  }
})
const blocks = [{ type: 'text' as const, text: 'Original report, exactly once' }]
const report = {
  version: 1 as const,
  kind: 'command' as const,
  result: { type: 'exit' as const, code: 7 }
}
const fact = {
  mailbox: 'run:receiver',
  messageId: 'mail-1',
  runId: 'run-1',
  from: 'term_sender',
  report
}

describe('mail provenance chooses its existing surface', () => {
  it('keeps historical helper and endpoint-only Setup reports out of orchestration without declaring a command or outcome', () => {
    for (const address of ['orca-bg-wake', 'term_sender']) {
      expect(mailReportPresentation({ from: source(address), blocks })).toEqual({
        kind: 'external-report',
        source: 'Setup',
        text: 'Original report, exactly once'
      })
    }
  })
  it('keeps actual actors and temporarily unobserved roles in orchestration', () => {
    for (const from of [
      source('term_sender', 'codex'),
      source('run:run-1'),
      source('dispatch:dispatch-1')
    ]) {
      expect(mailReportPresentation({ from, blocks })).toBeUndefined()
    }
  })
  it('an exact typed own-command event overrides actor presentation independently and never changes queue editor input', () => {
    const from = source('term_sender', 'claude')
    const body = { kind: 'message' as const, role: 'user' as const, from, blocks }
    const cards = projectQueuedMessageCards(
      [{ messageId: 'q', position: 1, state: 'waiting', body, mailDisplayReports: [fact] }],
      [],
      {}
    )
    expect(cards[0]).toMatchObject({
      text: 'Original report, exactly once',
      report: { kind: 'command-report', report: { result: { type: 'exit', code: 7 } } }
    })
    expect(body).toEqual({ kind: 'message', role: 'user', from, blocks })
    expect(
      mailReportPresentation({
        from,
        blocks,
        mailDisplayReports: [{ ...fact, messageId: 'wrong-mail' }]
      })
    ).toBeUndefined()
  })
  it('mixed sources retain the complete unsliced content once with no invented aggregate outcome', () => {
    const from = source('term_sender', 'codex')
    if (from.orchestration?.message !== 'mail-notice') {
      throw new Error('fixture')
    }
    const mixed = {
      ...from,
      orchestration: {
        ...from.orchestration,
        messages: [
          ...from.orchestration.messages,
          { messageId: 'mail-2', runId: 'run-1', from: 'external' }
        ]
      }
    }
    expect(mailReportPresentation({ from: mixed, blocks, mailDisplayReports: [fact] })).toEqual({
      kind: 'aggregate-report',
      source: 'Setup',
      text: 'Original report, exactly once'
    })
  })
  it('malformed and unknown optional declarations lose only their optional semantics', () => {
    for (const value of [
      { ...report, version: 2 },
      { ...report, result: { type: 'signal', signal: 9 } },
      'not-json',
      { ...report, extra: 'x'.repeat(2000) }
    ]) {
      expect(readMailDisplayReport(value)).toBeUndefined()
    }
    expect(readMailDisplayReport({ version: 1, kind: 'command' })).toEqual({
      version: 1,
      kind: 'command'
    })
  })
})

it('independently salvages exact response facts and never modifies canonical journal items', () => {
  const item = {
    itemId: 'one',
    revision: 1,
    sequence: 1,
    observedAt: 0,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks,
      from: source('term_sender', 'codex')
    }
  }
  const [projected] = applyMailDisplayProjection([item], {
    version: 1,
    entries: [
      { ...fact, itemId: 'one' },
      { ...fact, itemId: 7 },
      { ...fact, itemId: 'one', report: { ...report, version: 2 } },
      { ...fact, itemId: 'one', messageId: 'wrong' }
    ]
  })
  expect(mailDisplayReportsForItem(projected!)).toEqual([{ ...fact, itemId: 'one' }])
  expect(projected).toEqual(item)
  expect(mailDisplayReportsForItem(item)).toBeUndefined()
})

it('uses bounded visible source labels without interpreting them as command or agent identity', () => {
  for (const [address, label] of [
    ['\u200b', '—'],
    ['a'.repeat(1000), 'a'.repeat(200)]
  ]) {
    const original = source(address)
    const from = {
      ...original,
      senders: original.senders.map((sender) => ({ ...sender, name: null }))
    }
    expect(mailReportPresentation({ from, blocks })).toMatchObject({
      kind: 'external-report',
      source: label
    })
  }
})

it('keeps exact display facts through hydration, an unrelated live batch, same-item revision and full-item projection', () => {
  const item: AgentJournalRenderItem = {
    itemId: 'report',
    revision: 1,
    sequence: 1,
    observedAt: 0,
    body: { kind: 'message', role: 'user', blocks, from: source('term_sender', 'codex') }
  }
  const projection = { version: 1 as const, entries: [{ ...fact, itemId: item.itemId }] }
  const page: AgentSessionHistoryPage = {
    sessionId: 's',
    epoch: 'e',
    direction: 'tail',
    items: [item],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'e', sequence: 1 },
      newest: { epoch: 'e', sequence: 1 },
      nextCursor: { epoch: 'e', sequence: 1 }
    },
    liveCursor: { epoch: 'e', sequence: 1 },
    hasOlder: false,
    hasNewer: false,
    mailDisplayReports: projection
  }
  const present = (value: AgentJournalRenderItem) =>
    mailReportPresentation(projectStructuredItemToNativeChat(value)!)
  const hydrated = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'history-page',
    page
  })
  expect(present(hydrated.items[0]!)).toMatchObject({ kind: 'command-report', report })
  const unrelated = reduceStructuredAgentSession(hydrated, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      batch: {
        cursor: { epoch: 'e', sequence: 2 },
        items: [
          {
            ...item,
            itemId: 'other',
            sequence: 2,
            body: { kind: 'message', role: 'assistant', blocks }
          }
        ],
        removedItemIds: [],
        submissions: []
      }
    }
  })
  expect(unrelated.items[0]).toBe(hydrated.items[0])
  expect(present(unrelated.items[0]!)).toMatchObject({ kind: 'command-report', report })
  const revised = reduceStructuredAgentSession(unrelated, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      mailDisplayReports: projection,
      batch: {
        cursor: { epoch: 'e', sequence: 3 },
        items: [{ ...item, revision: 2 }],
        removedItemIds: [],
        submissions: []
      }
    }
  })
  expect(revised.items[0]?.revision).toBe(2)
  expect(present(revised.items[0]!)).toMatchObject({ kind: 'command-report', report })
  const full = applyMailDisplayProjection([{ ...item, revision: 3 }], projection)[0]!
  expect(present(full)).toMatchObject({ kind: 'command-report', report })
  const removed = reduceStructuredAgentSession(revised, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      batch: {
        cursor: { epoch: 'e', sequence: 4 },
        items: [],
        removedItemIds: ['report'],
        submissions: []
      }
    }
  })
  expect(removed.items.map((value) => value.itemId)).toEqual(['other'])
})

it('extracts clipped report content then restores the exact full body without accepting invalid ranges', () => {
  const original = source('term_sender', 'codex')
  if (original.orchestration?.message !== 'mail-notice') {
    throw new Error('fixture')
  }
  const from = {
    ...original,
    orchestration: {
      ...original.orchestration,
      messages: original.orchestration.messages.map((mail) => ({
        ...mail,
        content: { subject: [7, 12] as const, body: [18, 218] as const }
      }))
    }
  }
  const text = `notice\nTitle\nbody\n${'B'.repeat(200)}\nprivate envelope`
  const full = { from, blocks: [{ type: 'text' as const, text }], mailDisplayReports: [fact] }
  expect(
    mailReportPresentation({
      ...full,
      shortened: true,
      blocks: [{ type: 'text', text: `${text.slice(0, 40)}…` }]
    })
  ).toMatchObject({ kind: 'command-report', text: `Title\n\n${'B'.repeat(22)}\n\n…`, report })
  expect(mailReportPresentation(full)).toMatchObject({
    kind: 'command-report',
    text: `Title\n\n${'B'.repeat(200)}`,
    report
  })
  const invalid = {
    ...from,
    orchestration: {
      ...from.orchestration,
      messages: from.orchestration.messages.map((mail) => ({
        ...mail,
        content: { subject: [0, 5] as const, body: [-1, 20] as const }
      }))
    }
  }
  expect(mailReportPresentation({ ...full, from: invalid })).toEqual({
    kind: 'aggregate-report',
    source: 'Setup',
    text
  })
  expect(full.blocks[0].text).toBe(text)
})
