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

  it('requires exact field values, not prefixes', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(report('state=idle:app=ouro-test')).ready).toBe(false)
    expect(scanner.observe(report('state=idle-ish:app=ouro')).ready).toBe(false)
    expect(scanner.observe(report('xstate=idle:app=ouro')).ready).toBe(false)
  })

  it('accepts the fields in any order, with a BEL terminator', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe('\x1b]7501;app=ouro:state=idle\x07').ready).toBe(true)
  })

  it('ignores idle text outside a report', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(`${report('state=working:app=ouro')}state=idle:app=ouro`).ready).toBe(
      false
    )
    expect(scanner.observe('state=idle:app=ouro\r\n').ready).toBe(false)
  })

  it('requires both fields in the same report', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(`${report('state=idle:app=claude')}${report('app=ouro')}`).ready).toBe(
      false
    )
  })

  it('lets a later report in the chunk override an idle one', () => {
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(`${IDLE}${report('state=clear')}`).ready).toBe(false)
  })

  it('fires on an idle report split at every offset', () => {
    for (let split = 1; split < IDLE.length; split++) {
      const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
      expect(scanner.observe(`text${IDLE.slice(0, split)}`).ready).toBe(false)
      expect(scanner.observe(IDLE.slice(split)).ready).toBe(true)
    }
  })
  it('fires on a long idle report split past its first 512 characters', () => {
    const long = report(`state=idle:app=ouro:msg=${'a'.repeat(2700)}`)
    const scanner = createDraftPasteReadyScanner('ouro-composer-prompt')
    expect(scanner.observe(long.slice(0, 2000)).ready).toBe(false)
    expect(scanner.observe(long.slice(2000)).ready).toBe(true)
  })
})
