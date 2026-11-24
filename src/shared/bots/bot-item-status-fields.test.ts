import { expect, it } from 'vitest'
import { botItemStatusFields } from './bot-item-status-fields'

it('sends an older host a reason for a reason-less cancel, and a newer host none', () => {
  expect(botItemStatusFields('canceled', undefined, false)).toEqual({
    status: 'canceled',
    reason: 'Canceled'
  })
  expect(botItemStatusFields('canceled', undefined, true)).toEqual({ status: 'canceled' })
  expect(botItemStatusFields('canceled', 'Stale', false)).toEqual({
    status: 'canceled',
    reason: 'Stale'
  })
  expect(botItemStatusFields('waiting', 'Review', false)).toEqual({
    status: 'waiting',
    note: 'Review'
  })
  expect(botItemStatusFields('done', undefined, false)).toEqual({ status: 'done' })
})
