import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { botItemLinkCheck } from './bot-item-link-check'

const itemOf = (botId: string) => async () => ({ item: { owner: { botId, name: null } } })
const failingWith = (code: string) => async () => {
  throw new RuntimeRpcCallError({
    id: '1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'r' }
  })
}

describe('botItemLinkCheck', () => {
  it('opens only an item the linked bot owns', async () => {
    await expect(botItemLinkCheck('bot-1', itemOf('bot-1'))).resolves.toBe('open')
    await expect(botItemLinkCheck('bot-1', itemOf('bot-2'))).resolves.toBe('missing')
  })

  it('tells a missing item from one that could not be read', async () => {
    await expect(botItemLinkCheck('bot-1', failingWith('not_found'))).resolves.toBe('missing')
    await expect(botItemLinkCheck('bot-1', failingWith('items_unavailable'))).resolves.toBe(
      'unreadable'
    )
  })
})
