import { describe, expect, it } from 'vitest'
import { TerminalKittyApcFilter } from './terminal-kitty-apc-filter'

describe('TerminalKittyApcFilter', () => {
  it('returns plain chunks untouched without allocating', () => {
    const filter = new TerminalKittyApcFilter()
    const plain = 'plain terminal line\r\n\x1b[32mok\x1b[0m\r\n'
    expect(filter.filter(plain)).toBe(plain)
  })

  it('strips Kitty APC sequences across split introducers and ST/CAN/SUB terminators', () => {
    const filter = new TerminalKittyApcFilter()
    const chunks = [
      'A\x1b',
      '_',
      'Ga=T,f=100;AAAA\x1b',
      '\\\x1b_Gm=0;BBBB\x18C',
      '\x1b_',
      'Ga=p;CCCC\x1aD'
    ]
    const output = chunks.map((chunk) => filter.filter(chunk)).join('')
    // Split introducers ('\x1b', '_' or '\x1b_') emit ST ('\x1b\\') once '_G' / 'G' closes them back to ground.
    expect(output).toBe('A\x1b_\x1b\\C\x1b_\x1b\\D')

    filter.reset()
    expect(filter.filter('fresh\x1b_Ga=t;ZZZZ\x1b\\done')).toBe('freshdone')
  })
})
