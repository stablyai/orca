import { describe, expect, it } from 'vitest'

import { scanMode2031Sequences } from './terminal-color-scheme-protocol'

describe('terminal color scheme protocol', () => {
  it('detects mode 2031 subscribes in compound and split private mode sequences', () => {
    expect(scanMode2031Sequences('', '\x1b[?25;2031h')).toMatchObject({
      subscribe: true,
      finalState: 'subscribed',
      tail: ''
    })

    const first = scanMode2031Sequences('', '\x1b[?20')
    expect(first).toMatchObject({ subscribe: false, finalState: null, tail: '\x1b[?20' })

    expect(scanMode2031Sequences(first.tail, '31h')).toMatchObject({
      subscribe: true,
      finalState: 'subscribed',
      tail: ''
    })
  })

  it('reports the final mode 2031 state in match order', () => {
    expect(scanMode2031Sequences('', '\x1b[?2031h\x1b[?2031l')).toMatchObject({
      subscribe: true,
      unsubscribe: true,
      finalState: 'unsubscribed',
      tail: ''
    })

    expect(scanMode2031Sequences('', '\x1b[?2031l\x1b[?2031h')).toMatchObject({
      subscribe: true,
      unsubscribe: true,
      finalState: 'subscribed',
      tail: ''
    })
  })
})
