import { expect, it, vi } from 'vitest'
import { orchestrationMailFixture } from '../../main/runtime/orchestration/mailbox/orchestration-mail.test-fixture'
import { agentMessageTranscriptText } from './agent-message-display-text'
import { agentMessageHeading } from './agent-message-presentation'
import { readAgentMessageSource } from './agent-session-message-source'
import * as display from './orchestration-mail-display-text'
import { boundedFrameItem } from '../../main/native-chat/agent-session-wire/publication/history/agent-session-bounded-frame-item'
import { measureHistoryItem } from '../../main/native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'

it('shows exact fields, including multiline subjects and protocol-looking body text, without changing input', () => {
  const body = `  Body 🐋\r\n[Reply: keep this]\n${'─'.repeat(60)}`
  const message = orchestrationMailFixture({
    subject: 'Title\ncontinued',
    body,
    payload: 'a_b ``` c'
  })
  const original = structuredClone(message)
  expect(agentMessageTranscriptText(message.blocks, message.from)).toBe(
    `Title\ncontinued\n\n${body}\n\n\`\`\`\`\na_b \`\`\` c\n\`\`\`\``
  )
  const empty = orchestrationMailFixture({ body: '' })
  expect(agentMessageTranscriptText(empty.blocks, empty.from)).toBe('Review complete')
  expect(message).toEqual(original)
})

it('cuts only the exact historical envelope, preserving its middle and unknown or authority-tagged input', () => {
  const message = orchestrationMailFixture({
    subject: 'Title\ncontinued',
    body: 'Text\n[Payload: literal]'
  })
  if (message.from.orchestration?.message !== 'mail-notice') {
    throw new Error('missing mail')
  }
  const { content: _content, ...mail } = message.from.orchestration.messages[0]
  const from = {
    ...message.from,
    orchestration: { ...message.from.orchestration, messages: [mail] }
  }
  expect(agentMessageTranscriptText(message.blocks, from)).toBe(
    'Title\ncontinued\nText\n[Payload: literal]'
  )
  const block = message.blocks[0]
  if (block.type !== 'text') {
    throw new Error('missing text')
  }
  for (const text of [
    block.text.replace('(question)', '[LEGACY READ-ONLY] (question)'),
    block.text.replace('--id msg_review', '--id other'),
    'Ordinary text'
  ]) {
    expect(agentMessageTranscriptText([{ type: 'text', text }], from)).toBe(text)
  }
})

it('salvages malformed optional ranges without dropping provenance, and round-trips valid ones', () => {
  const message = orchestrationMailFixture()
  expect(readAgentMessageSource(JSON.parse(JSON.stringify(message.from)))).toEqual(message.from)
  const source = readAgentMessageSource(
    JSON.parse(JSON.stringify(message.from).replace('"subject":[', '"subject":["bad",'))
  )
  expect(source?.senders).toEqual(message.from.senders)
  expect(source && agentMessageHeading(source, message)).toBe('worker')
  expect(agentMessageTranscriptText(message.blocks, source)).toBe(
    'Review complete\nThe result is ready.'
  )
})

it('shows a clean preview through the actual phone frame shortener without duplicating the body', () => {
  const message = orchestrationMailFixture({ body: 'Important result. '.repeat(7000) })
  const item = boundedFrameItem(
    measureHistoryItem({
      itemId: 'mail',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: message.blocks, from: message.from }
    })
  ).item
  expect(item.shortened).toBe(true)
  if (item.body.kind !== 'message') {
    throw new Error('mail was not retained')
  }
  const text = agentMessageTranscriptText(
    item.body.blocks,
    readAgentMessageSource(item.body.from),
    item.shortened
  )
  expect(text).toMatch(/^Review complete\n\nImportant result\./)
  expect(text.endsWith('…')).toBe(true)
  expect(text).not.toContain('──── From:')
  expect(JSON.stringify(message.from).length).toBeLessThan(600)
})

it.each([10, 100])('extracts %i immutable rows once and invalidates changed source', (count) => {
  const extract = vi.spyOn(display, 'orchestrationMailDisplayText')
  const messages = Array.from({ length: count }, () => orchestrationMailFixture())
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (const message of messages) {
        agentMessageTranscriptText(message.blocks, readAgentMessageSource(message.from))
      }
    }
    expect(extract).toHaveBeenCalledTimes(count)
    const message = messages[0]
    const changed = readAgentMessageSource({
      ...message.from,
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:run_review',
        dispatchId: null,
        messages: [{ messageId: 'other-message', runId: 'run_review', from: 'term_worker' }]
      }
    })
    agentMessageTranscriptText(message.blocks, changed)
    expect(extract).toHaveBeenCalledTimes(count + 1)
  } finally {
    extract.mockRestore()
  }
})
