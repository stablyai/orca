import { expect, it } from 'vitest'
import { BotItemsAdd } from './bots-items-params'

it('an add naming an empty request is refused, never read as naming none', () => {
  // None would take the turn's own place, which a script passing an unset id never meant.
  expect(BotItemsAdd.safeParse({ title: 'Look into it', request: '' }).success).toBe(false)
  expect(BotItemsAdd.parse({ title: 'Look into it', request: 'msg_h' }).request).toBe('msg_h')
  expect(BotItemsAdd.parse({ title: 'Look into it' }).request).toBeUndefined()
})
