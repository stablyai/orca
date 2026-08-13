import { describe, expect, it } from 'vitest'
import { toSafeTerminalDraftPaste } from './terminal-draft-paste'

describe('terminal draft paste', () => {
  it('neutralizes nested bracketed-paste terminators and submit controls', () => {
    const payload = toSafeTerminalDraftPaste('review\u001b[201~\rsubmit\u001b[200~next')
    const begin = '\u001b[200~'
    const end = '\u001b[201~'

    expect(payload).toBe(`${begin}review␛[201~\rsubmit␛[200~next${end}`)
    expect(payload.split(begin)).toHaveLength(2)
    expect(payload.split(end)).toHaveLength(2)
    expect(payload).not.toContain(`${end}\rsubmit`)
  })
})
