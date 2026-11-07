import { describe, expect, it } from 'vitest'
import { LinkSendParams } from './session-link'
const request = {
  id: 'pair',
  operationId: 'ask',
  body: 'Continue?',
  kind: 'owner-request',
  choices: [{ label: 'Offline only' }, { label: 'Approve $0.10' }]
}
describe('owner question protocol', () => {
  it('accepts a legacy free-text question and optional bounded choices', () => {
    expect(LinkSendParams.parse({ ...request, choices: undefined }).choices).toBeUndefined()
    expect(LinkSendParams.parse(request).choices).toEqual(request.choices)
  })
  it.each([
    { choices: [{ label: 'Only one' }] },
    { choices: Array.from({ length: 5 }, (_, i) => ({ label: String(i) })) },
    { choices: [{ label: 'x'.repeat(81) }, { label: 'No' }] },
    { choices: [{ label: 'Yes', description: 'x'.repeat(201) }, { label: 'No' }] },
    { choices: [{ label: ' ' }, { label: 'No' }] },
    { choices: [{ label: 'Same' }, { label: 'Same' }] },
    { kind: 'message' },
    { choices: undefined, allowOther: false }
  ])('refuses invalid or unanswerable choices before host mutation: %j', (fields) => {
    expect(LinkSendParams.safeParse({ ...request, ...fields }).success).toBe(false)
  })
})
