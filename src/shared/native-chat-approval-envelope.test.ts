import { describe, expect, it } from 'vitest'
import { parseNativeChatApprovalEnvelope } from './native-chat-approval-envelope'

const ESC = String.fromCharCode(27)

describe('parseNativeChatApprovalEnvelope', () => {
  it('reads tool and summary with the default TUI answer keys', () => {
    expect(
      parseNativeChatApprovalEnvelope(
        JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
      )
    ).toEqual({ tool: 'Bash', summary: 'rm -rf build', allowSend: '1', denySend: ESC })
  })

  it.each([
    ['claude', '1'],
    ['codex', '1'],
    ['opencode', '\r'],
    ['opencode2', '\r'],
    ['zcode', '\r']
  ])('allows a %s prompt with %j', (agent, allowSend) => {
    expect(
      parseNativeChatApprovalEnvelope(JSON.stringify({ approval: { tool: 'shell' } }), agent)
    ).toEqual({ tool: 'shell', allowSend, denySend: ESC })
  })

  it.each([
    ['missing', { tool: 'Edit' }],
    ['empty', { tool: 'Edit', summary: '' }],
    ['non-string', { tool: 'Edit', summary: 42 }]
  ])('omits a %s summary', (_label, approval) => {
    expect(parseNativeChatApprovalEnvelope(JSON.stringify({ approval }))).not.toHaveProperty(
      'summary'
    )
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['invalid JSON', '{bad'],
    ['a JSON primitive', '"approval"'],
    ['JSON null', 'null'],
    ['an array', '[]'],
    ['no approval', '{}'],
    ['a question envelope', JSON.stringify({ questions: [] })],
    ['a non-object approval', JSON.stringify({ approval: 'Bash' })],
    ['no tool', JSON.stringify({ approval: {} })],
    ['an empty tool', JSON.stringify({ approval: { tool: '' } })],
    ['a non-string tool', JSON.stringify({ approval: { tool: 7 } })]
  ])('returns null for %s', (_label, input) => {
    expect(parseNativeChatApprovalEnvelope(input)).toBeNull()
  })
})
