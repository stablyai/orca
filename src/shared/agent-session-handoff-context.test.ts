import { expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat/native-chat-types'
import { buildAgentSessionHandoffContext } from './native-chat/transcript/agent-session-handoff-context'

function message(
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks']
): NativeChatMessage {
  return { id: 'entry', role, blocks, source: 'transcript', timestamp: null }
}

function text(role: NativeChatMessage['role'], value: string): NativeChatMessage {
  return message(role, [{ type: 'text', text: value }])
}
it('retains saved decisions, delivery states and image references while excluding reasoning and creation notices', () => {
  const context = buildAgentSessionHandoffContext([
    { ...text('system', 'Private worker assignment'), agentStart: true },
    {
      ...message('system', [
        { type: 'text', text: 'Private bot tool card' },
        { type: 'tool-call', name: 'Private tool', input: 'Private config' }
      ]),
      toolAdded: {
        botId: 'bot-1',
        tool: { name: 'search', detail: 'https://search.example/mcp', remote: true },
        addedAt: 1
      }
    },
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
  expect(context).toContain('[tool Read input preview] call=a a.ts')
  expect(context).toContain('[tool result] call=a file contents')
  expect(context).toContain('[tool Search input preview] call=b pattern')
  expect(context).toContain('[tool result] call=b search result')
  expect(context).toContain('[tool result] call=unknown standalone result')
})
