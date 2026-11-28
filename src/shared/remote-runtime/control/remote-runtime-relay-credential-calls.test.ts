import { expect, it } from 'vitest'
import { createRelayCredentialCalls } from './remote-runtime-relay-credential-calls'

it('ends every waiting credential call with its link, and ignores a late answer', async () => {
  const sent: string[] = []
  const calls = createRelayCredentialCalls('token', (payload) => sent.push(payload) > 0)
  const waiting = calls.port.sendRequest('pairing.getEndpoints', {})
  calls.failAll(new Error('relay link closed'))
  await expect(waiting).rejects.toThrow('relay link closed')
  const { id }: { id: string } = JSON.parse(sent[0])
  expect(
    calls.answer(JSON.stringify({ id, ok: true, result: {}, _meta: { runtimeId: 'r' } }))
  ).toBe(false)
})
