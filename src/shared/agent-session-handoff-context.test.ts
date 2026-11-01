import { expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { buildAgentSessionHandoffContext } from './agent-session-handoff-context'

function message(
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks']
): NativeChatMessage {
  return { id: 'entry', role, blocks, source: 'transcript', timestamp: null }
}

function text(role: NativeChatMessage['role'], value: string): NativeChatMessage {
  return message(role, [{ type: 'text', text: value }])
}

it('keeps the conversation around a huge failed assertion and preserves tool attribution', () => {
  const output = `AssertionError: expected CURRENT PART\nReceived: "${'a'.repeat(200_000)}"\nTests: 2 failed`
  const context = buildAgentSessionHandoffContext([
    text('user', 'Review the paged tool output'),
    message('assistant', [
      {
        type: 'tool-call',
        name: 'shell',
        input: { command: 'pnpm test viewer.test.ts' },
        callId: 'test',
        state: 'failed'
      },
      { type: 'tool-result', output, callId: 'test', isError: true }
    ]),
    text('assistant', 'Request changes: appends reset the reader position.'),
    text('user', 'Should we redo the viewer?')
  ])
  expect(context).toContain('[user] Review the paged tool output')
  expect(context).toContain('[tool shell failed input preview]')
  expect(context).toContain('pnpm test viewer.test.ts')
  expect(context).toContain('[tool result error] AssertionError: expected CURRENT PART')
  expect(context).toContain('middle omitted')
  expect(context).toContain('Tests: 2 failed')
  expect(context).toContain('[assistant] Request changes: appends reset the reader position.')
  expect(context).toContain('[user] Should we redo the viewer?')
  expect(context).not.toContain('a'.repeat(2_000))
  expect(context.length).toBeLessThan(4_000)
  expect(context.indexOf('Review the paged')).toBeLessThan(context.indexOf('[tool shell'))
  expect(context.indexOf('Tests: 2 failed')).toBeLessThan(context.indexOf('Request changes'))
})

it('reserves the latest user and assistant messages despite later bulk text and many tool results', () => {
  const context = buildAgentSessionHandoffContext([
    text('user', `LATEST REQUEST ${'request '.repeat(10_000)} REQUEST END`),
    text('assistant', `LATEST RESPONSE ${'response '.repeat(10_000)} RESPONSE END`),
    ...Array.from({ length: 100 }, (_, index) =>
      text('system', `status ${index} ${'detail '.repeat(1_000)}`)
    ),
    ...Array.from({ length: 100 }, (_, index) =>
      message('tool', [{ type: 'tool-result', output: `RESULT ${index} ${'output '.repeat(500)}` }])
    )
  ])
  expect(context.length).toBeLessThanOrEqual(36_000)
  for (const marker of [
    'LATEST REQUEST',
    'REQUEST END',
    'LATEST RESPONSE',
    'RESPONSE END',
    'RESULT 99'
  ]) {
    expect(context).toContain(marker)
  }
  expect(context).not.toContain('RESULT 0 ')
  expect(context).toContain('messages or tool details omitted')
  expect(context.indexOf('LATEST REQUEST')).toBeLessThan(context.indexOf('LATEST RESPONSE'))
  expect(context.indexOf('LATEST RESPONSE')).toBeLessThan(context.indexOf('RESULT 99'))
})

it('bounds tool argument traversal before serialization, including huge keys and collections', () => {
  const input = {
    command: 'Read the fixture',
    ['key'.repeat(100_000)]: 'value'.repeat(100_000),
    values: Array.from({ length: 100_000 }, () => 'fixture'.repeat(100)),
    toJSON() {
      throw new Error('Full input must not be serialized for an excerpt')
    }
  }
  const context = buildAgentSessionHandoffContext([
    message('assistant', [{ type: 'tool-call', name: 'shell', input }])
  ])
  expect(context).toContain('Read the fixture')
  expect(context).toContain('input preview')
  expect(context.length).toBeLessThan(1_500)
  expect(context).not.toContain('key'.repeat(100))
})

it('preserves Unicode at both excerpt boundaries and across multiple blocks', () => {
  const context = buildAgentSessionHandoffContext([
    message('assistant', [
      { type: 'text', text: `START ${'😀'.repeat(20_000)} END` },
      { type: 'tool-call', name: 'shell', input: { command: `a${'😀'.repeat(1_000)}` } },
      { type: 'tool-result', output: `FAIL ${'😀'.repeat(20_000)} FAILED` },
      { type: 'text', text: 'Last detail' }
    ])
  ])
  expect(context.isWellFormed()).toBe(true)
  for (const marker of ['START', 'END', 'FAIL', 'FAILED', 'Last detail']) {
    expect(context).toContain(marker)
  }
  expect(context.length).toBeLessThanOrEqual(36_000)
  expect(context.indexOf('START')).toBeLessThan(context.indexOf('[tool shell'))
  expect(context.indexOf('FAILED')).toBeLessThan(context.indexOf('Last detail'))
})

it('retains saved decisions, delivery states and image references while excluding reasoning and creation notices', () => {
  const context = buildAgentSessionHandoffContext([
    { ...text('system', 'Private worker assignment'), agentStart: true },
    text('reasoning', 'Private reasoning'),
    text('system', 'Prompt state: resolved\nSelected choice: Keep planning'),
    { ...text('user', 'Do not deploy'), queued: true },
    { ...text('user', 'Unsent request'), unsent: true },
    message('user', [{ type: 'image-ref', path: '/work/reference.png' }])
  ])
  expect(context).toContain('Selected choice: Keep planning')
  expect(context).toContain('[user queued] Do not deploy')
  expect(context).toContain('[user unsent] Unsent request')
  expect(context).toContain('[user] [image] /work/reference.png')
  expect(context).not.toContain('Private')
})

it('pairs out-of-order tool results by call ID and labels standalone results without guessing a tool', () => {
  const context = buildAgentSessionHandoffContext([
    message('assistant', [
      { type: 'tool-call', name: 'Read', input: 'a.ts', callId: 'a' },
      { type: 'tool-call', name: 'Search', input: 'pattern', callId: 'b' },
      { type: 'tool-result', output: 'search result', callId: 'b' },
      { type: 'tool-result', output: 'file contents', callId: 'a' },
      { type: 'tool-result', output: 'standalone result', callId: 'unknown' }
    ])
  ])
  expect(context).toContain('[tool Read input preview] a.ts\n[tool result] file contents')
  expect(context).toContain('[tool Search input preview] pattern\n[tool result] search result')
  expect(context).toContain('[tool result call=unknown] standalone result')
})

it('respects the total bound with oversized metadata and a nearly exhausted tool budget', () => {
  const context = buildAgentSessionHandoffContext(
    Array.from({ length: 1_000 }, () =>
      message('assistant', [
        { type: 'tool-call', name: 'n'.repeat(10_000), input: 'i'.repeat(10_000), state: 'failed' },
        { type: 'tool-result', output: 'o'.repeat(10_000), isError: true }
      ])
    )
  )
  expect(context.length).toBeLessThanOrEqual(8_100)
  expect(context).toContain('[tool result error]')
  expect(buildAgentSessionHandoffContext([])).toBe('')
})

it('retains readable provider failures and warnings while excluding wordless frames', () => {
  const frame = {
    provider: 'codex',
    kind: 'notification:hook/completed',
    payload: { head: '{}', byteLength: 2, digest: 'abc', truncated: false }
  }
  const context = buildAgentSessionHandoffContext([
    text('user', 'Run the tests'),
    message('system', [
      {
        type: 'text',
        text: 'Codex PreToolUse hook failed: permission denied',
        tone: 'error',
        providerFrame: frame
      },
      {
        type: 'text',
        text: 'The configured sandbox is unavailable',
        tone: 'warning',
        providerFrame: frame
      },
      { type: 'text', text: 'Readable provider notice', providerFrame: frame },
      { type: 'text', text: 'codex · notification:hook/completed', providerFrame: frame }
    ])
  ])
  expect(context).toContain('permission denied')
  expect(context).toContain('The configured sandbox is unavailable')
  expect(context).toContain('Readable provider notice')
  expect(context).not.toContain('codex · notification:hook/completed')
})

it.each(['queued', 'unsent'] as const)(
  'reserves delivered conversation ahead of oversized %s messages',
  (delivery) => {
    const context = buildAgentSessionHandoffContext([
      text('user', `LATEST REQUEST ${'request '.repeat(10_000)} REQUEST END`),
      text('assistant', `LATEST RESPONSE ${'response '.repeat(10_000)} RESPONSE END`),
      ...Array.from({ length: 4 }, (_, index) => ({
        ...text('user', `PENDING ${index} ${'pending '.repeat(10_000)} PENDING END`),
        [delivery]: true
      }))
    ])
    expect(context.length).toBeLessThanOrEqual(36_000)
    for (const marker of ['LATEST REQUEST', 'REQUEST END', 'LATEST RESPONSE', 'RESPONSE END']) {
      expect(context).toContain(marker)
    }
    expect(context).toContain(`[user ${delivery}] PENDING 3`)
    expect(context).not.toContain('PENDING 0 ')
  }
)

it('excerpts multi-block messages as a whole without losing opening instructions or tool order', () => {
  const context = buildAgentSessionHandoffContext([
    message('user', [
      { type: 'text', text: 'Do not deploy; only inspect' },
      { type: 'text', text: `Attached reference: ${'reference '.repeat(10_000)} REFERENCE END` }
    ]),
    message('assistant', [
      { type: 'text', text: 'Inspection only; no deployment' },
      { type: 'text', text: `Inspection notes: ${'detail '.repeat(10_000)}` },
      { type: 'tool-call', name: 'shell', input: 'pnpm test', callId: 'test' },
      { type: 'tool-result', output: 'Tests: 2 failed', callId: 'test', isError: true },
      { type: 'text', text: 'NEXT STEP: fix the failing tests' }
    ])
  ])
  expect(context.length).toBeLessThanOrEqual(36_000)
  expect(context).toContain('[user] Do not deploy; only inspect')
  expect(context).toContain('REFERENCE END')
  expect(context).toContain('[assistant] Inspection only; no deployment')
  expect(context).toContain('NEXT STEP: fix the failing tests')
  expect(context.indexOf('Inspection only')).toBeLessThan(context.indexOf('[tool shell'))
  expect(context.indexOf('Tests: 2 failed')).toBeLessThan(context.indexOf('NEXT STEP'))
})

it('uses the available context budget when there is no tool evidence', () => {
  const messages = Array.from({ length: 5 }, (_, index) =>
    text(index % 2 ? 'assistant' : 'user', `MESSAGE ${index} ${'x'.repeat(6_000)} END ${index}`)
  )
  const context = buildAgentSessionHandoffContext(messages)
  for (let index = 0; index < messages.length; index++) {
    expect(context).toContain(`MESSAGE ${index}`)
    expect(context).toContain(`END ${index}`)
  }
  expect(context.includes('omitted')).toBe(false)
  expect(context.length).toBeLessThanOrEqual(36_000)
})

it('keeps block-only task reports and subagent rosters without duplicating frozen twins', () => {
  const task = {
    type: 'background-task',
    taskId: 'test',
    kind: 'command',
    label: 'Run tests',
    state: 'blocked',
    error: 'The test runner could not start'
  } as const
  const context = buildAgentSessionHandoffContext([
    message('system', [task]),
    message('system', [
      {
        type: 'subagent-group',
        groupId: 'review',
        agents: [{ id: 'a', label: 'Review', state: 'failed' }]
      }
    ]),
    message('system', [{ type: 'text', text: 'The test runner could not start' }, task])
  ])
  expect(context.match(/The test runner could not start/g)).toHaveLength(2)
  expect(context).toContain('[subagents]')
  expect(context).toContain('failed')
})

it('omits assistant visual directives while preserving user text and literal code examples', () => {
  const directive = '::orca-visual{file="chart.html"}'
  const code = ['```text', directive, '```'].join('\n')
  const context = buildAgentSessionHandoffContext([
    text('user', `Explain this:\n${directive}`),
    text('assistant', `The result is in the chart.\n${directive}\n\nExample:\n${code}`)
  ])
  expect(context).toContain(`[user] Explain this:\n${directive}`)
  expect(context).not.toContain(`chart.\n${directive}`)
  expect(context).toContain(code)
})
