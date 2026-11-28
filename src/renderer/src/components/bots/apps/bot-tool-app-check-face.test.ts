import { describe, expect, it } from 'vitest'
import { botToolAppCheckFace } from './bot-tool-app-check-face'

describe('botToolAppCheckFace', () => {
  it('says a tool won’t start over its sign-in, and when renaming it is the fix', () => {
    expect(botToolAppCheckFace({ kind: 'failed', detail: 'server down' }, false)).toBe('wontStart')
    expect(botToolAppCheckFace({ kind: 'failed', reason: 'nameTaken' }, false)).toBe('nameTaken')
  })

  it('says an unfinished check over its sign-in, and a check under way leaves the sign-in', () => {
    expect(botToolAppCheckFace({ kind: 'unconfirmed', detail: 'not checked' }, false)).toBe(
      'unconfirmed'
    )
    expect(botToolAppCheckFace({ kind: 'unconfirmed' }, false)).toBeNull()
  })

  it('leaves the sign-in to speak when nothing was found, or one is under way', () => {
    expect(botToolAppCheckFace(undefined, false)).toBeNull()
    expect(botToolAppCheckFace({ kind: 'sign-in' }, false)).toBeNull()
    expect(botToolAppCheckFace({ kind: 'failed' }, true)).toBeNull()
  })
})
