import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'

const report = (pairs: string): string => `\x1b]7501;${pairs}\x1b\\`
// What `ouro chat` writes as its composer opens (title is base64 "slugger").
const IDLE = report('state=idle:app=ouro:title=c2x1Z2dlcg==')

describe('ouro-composer-prompt', () => {
  it('waits through the agent picker and fires on the chat idle report', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe('\x1b[?2004h% ouro chat\r\n').ready).toBe(false)
    expect(
      scanner.observe('who do you want to talk to?\r\n1. slugger\r\n2. butler\r\n> ').ready
    ).toBe(false)
    expect(scanner.observe(`\x1b[2J${IDLE}`)).toEqual({ ready: true, armQuietTimer: false })
  })

  it('fires on an idle report split across chunks', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(IDLE.slice(0, 4)).ready).toBe(false)
    expect(scanner.observe(IDLE.slice(4, 20)).ready).toBe(false)
    expect(scanner.observe(IDLE.slice(20)).ready).toBe(true)
  })

  it('ignores other apps and other states', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(report('state=idle:app=claude')).ready).toBe(false)
    expect(scanner.observe(report('state=working:app=ouro')).ready).toBe(false)
    expect(scanner.observe(report('state=clear')).ready).toBe(false)
  })
})
