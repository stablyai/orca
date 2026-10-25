import { describe, expect, it } from 'vitest'
import { PROGRAM_STATUS_QUERY_REPLY, parseProgramStatusBody } from './protocol'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('parseProgramStatusBody', () => {
  it('recognizes the feature-detection query', () => {
    expect(parseProgramStatusBody('?')).toEqual({ type: 'query' })
    expect(PROGRAM_STATUS_QUERY_REPLY).toBe(
      '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
    )
  })

  it('parses the spec example with a base64 message', () => {
    const msg = 'Apply 3 to add, 1 to change, 0 to destroy?'
    expect(
      parseProgramStatusBody(`state=blocked:kind=permission:app=terraform:msg=${b64(msg)}`)
    ).toEqual({
      type: 'report',
      report: { id: null, state: 'blocked', kind: 'permission', app: 'terraform', msg }
    })
  })

  it('decodes unpadded base64 and UTF-8 text', () => {
    const encoded = b64('déjà vu ✓').replace(/=+$/, '')
    expect(parseProgramStatusBody(`state=done:msg=${encoded}`)).toMatchObject({
      report: { msg: 'déjà vu ✓' }
    })
  })

  it('ignores reports without a recognized state or with a malformed id', () => {
    expect(parseProgramStatusBody('app=x')).toBeNull()
    expect(parseProgramStatusBody('state=paused')).toBeNull()
    expect(parseProgramStatusBody('state=working:id=a//b')).toBeNull()
    expect(parseProgramStatusBody(`state=working:id=${'a/'.repeat(8)}a`)).toBeNull()
  })

  it('discards a report with an over-long key or any over-limit text occurrence', () => {
    expect(parseProgramStatusBody(`state=working:${'k'.repeat(17)}=v`)).toBeNull()
    const oversized = b64('x'.repeat(2049))
    expect(parseProgramStatusBody(`state=done:msg=${oversized}:msg=${b64('ok')}`)).toBeNull()
    expect(parseProgramStatusBody(`state=done:title=${b64('t'.repeat(193))}:title=e`)).toBeNull()
    expect(parseProgramStatusBody(`state=clear:app=${'a'.repeat(33)}`)).toBeNull()
    expect(parseProgramStatusBody(`state=clear:id=${'a'.repeat(129)}:id=ok`)).toBeNull()
  })

  it('skips malformed pairs, trims whitespace, and lets the last repeat win', () => {
    expect(parseProgramStatusBody(' state = idle :junk:K=v:app=a:app=b:x=has space')).toEqual({
      type: 'report',
      report: { id: null, state: 'idle', app: 'b' }
    })
  })

  it('keeps kind only on blocked and progress only on working/blocked within 0-100', () => {
    expect(parseProgramStatusBody('state=working:kind=permission:progress=40')).toMatchObject({
      report: { state: 'working', progress: 40 }
    })
    expect(parseProgramStatusBody('state=working:progress=101')).toEqual({
      type: 'report',
      report: { id: null, state: 'working' }
    })
    expect(parseProgramStatusBody('state=done:progress=50')).toEqual({
      type: 'report',
      report: { id: null, state: 'done' }
    })
    expect(parseProgramStatusBody('state=blocked:kind=unknown')).toEqual({
      type: 'report',
      report: { id: null, state: 'blocked' }
    })
  })

  it('treats an out-of-charset app as absent', () => {
    expect(parseProgramStatusBody('state=idle:app=a,b')).toEqual({
      type: 'report',
      report: { id: null, state: 'idle' }
    })
  })

  it('discards the whole report when text has a control character or bad base64', () => {
    expect(parseProgramStatusBody(`state=done:msg=${b64('two\nlines')}`)).toBeNull()
    expect(parseProgramStatusBody(`state=done:title=${b64('\u0085')}`)).toBeNull()
    expect(parseProgramStatusBody('state=done:msg=a-b_')).toBeNull()
    expect(parseProgramStatusBody('state=done:msg=abcde')).toBeNull()
    // Out-of-charset bytes make a malformed pair, which is skipped rather than fatal.
    expect(parseProgramStatusBody('state=done:msg=@@@@')).toEqual({
      type: 'report',
      report: { id: null, state: 'done' }
    })
    expect(
      parseProgramStatusBody(`state=done:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`)
    ).toBeNull()
  })

  it('enforces the encoded and decoded text limits', () => {
    expect(parseProgramStatusBody(`state=done:title=${b64('t'.repeat(192))}`)).not.toBeNull()
    expect(parseProgramStatusBody(`state=done:title=${b64('t'.repeat(193))}`)).toBeNull()
    expect(parseProgramStatusBody(`state=done:msg=${b64('m'.repeat(2048))}`)).not.toBeNull()
    expect(parseProgramStatusBody(`state=done:msg=${b64('m'.repeat(2049))}`)).toBeNull()
  })

  it('accepts clear with and without an id', () => {
    expect(parseProgramStatusBody('state=clear')).toEqual({
      type: 'report',
      report: { id: null, state: 'clear' }
    })
    expect(parseProgramStatusBody('state=clear:id=build/test')).toEqual({
      type: 'report',
      report: { id: 'build/test', state: 'clear' }
    })
  })
})
