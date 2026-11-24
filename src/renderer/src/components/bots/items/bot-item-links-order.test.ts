import { describe, expect, it } from 'vitest'
import type { BotItemLinkRow } from '../../../../../shared/bots/bot-item-link-rows'
import type { BotItemWorkerState } from '../../../../../shared/bots/bot-items'
import { botItemLinksOrder } from './bot-item-links-order'

function worker(key: string, state: BotItemWorkerState): BotItemLinkRow {
  return {
    kind: 'worker',
    key,
    link: { kind: 'dispatch', ref: key, state } as Extract<
      BotItemLinkRow,
      { kind: 'worker' }
    >['link']
  }
}

const serverPr = (key: string): BotItemLinkRow => ({ kind: 'server-pr', key })

describe('botItemLinksOrder', () => {
  it('moves finished workers after everything else, keeping each group in order', () => {
    const rows = [
      worker('a', 'completed'),
      worker('b', 'working'),
      serverPr('c'),
      worker('d', 'failed'),
      worker('e', 'unknown'),
      worker('f', 'stopped'),
      worker('g', 'missing')
    ]
    expect(botItemLinksOrder(rows).map((row) => row.key)).toEqual([
      'b',
      'c',
      'e',
      'a',
      'd',
      'f',
      'g'
    ])
  })

  it('leaves a list with no finished worker as it is', () => {
    const rows = [serverPr('x'), worker('y', 'working')]
    expect(botItemLinksOrder(rows)).toEqual(rows)
  })
})
