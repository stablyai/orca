import { describe, expect, it } from 'vitest'
import { decideCollabAutoDraft } from './collab-auto-draft'

describe('decideCollabAutoDraft', () => {
  it('places on armed working→done with reply', () => {
    const d = decideCollabAutoDraft({
      armed: true,
      wasWorking: true,
      state: 'done',
      reply: 'Login form sketch — add email validation.',
      alreadyPlacedKeys: new Set(),
      paneKey: 't1:l1'
    })
    expect(d.place).toBe(true)
    if (d.place) {
      expect(d.body).toContain('email validation')
    }
  })

  it('ignores when not armed after Send', () => {
    expect(
      decideCollabAutoDraft({
        armed: false,
        wasWorking: true,
        state: 'done',
        reply: 'hello',
        alreadyPlacedKeys: new Set(),
        paneKey: 't1:l1'
      })
    ).toEqual({ place: false, reason: 'not-armed' })
  })

  it('dedupes same reply', () => {
    const reply = 'same reply text here for dedupe key'
    const key = `t1:l1:${reply.slice(0, 160)}`
    expect(
      decideCollabAutoDraft({
        armed: true,
        wasWorking: true,
        state: 'done',
        reply,
        alreadyPlacedKeys: new Set([key]),
        paneKey: 't1:l1'
      }).place
    ).toBe(false)
  })
})
