import { describe, expect, it } from 'vitest'
import { classifyExternalAppUrl, TERMINAL_WEB_AND_APP_URL_REGEX } from './external-app-url'

describe('classifyExternalAppUrl', () => {
  it('accepts http and https', () => {
    expect(classifyExternalAppUrl('https://example.com/a')).toMatchObject({
      ok: true,
      kind: 'http'
    })
    expect(classifyExternalAppUrl('http://localhost:3000')).toMatchObject({
      ok: true,
      kind: 'http'
    })
  })

  it('accepts custom app schemes', () => {
    expect(classifyExternalAppUrl('obsidian://open?vault=notes&file=Inbox.md')).toMatchObject({
      ok: true,
      kind: 'custom',
      schemeLabel: 'obsidian'
    })
    expect(classifyExternalAppUrl('vscode://file/tmp/x')).toMatchObject({
      ok: true,
      kind: 'custom',
      schemeLabel: 'vscode'
    })
  })

  it('denies dangerous schemes', () => {
    expect(classifyExternalAppUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'denied'
    })
    expect(classifyExternalAppUrl('data:text/html,hi')).toEqual({
      ok: false,
      reason: 'denied'
    })
    expect(classifyExternalAppUrl('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'denied'
    })
    expect(classifyExternalAppUrl('smb://server/share')).toEqual({
      ok: false,
      reason: 'denied'
    })
    expect(classifyExternalAppUrl('jnlp://example.com/app.jnlp')).toEqual({
      ok: false,
      reason: 'denied'
    })
    expect(classifyExternalAppUrl('ms-msdt://idpcmdi?page=...')).toEqual({
      ok: false,
      reason: 'denied'
    })
    expect(classifyExternalAppUrl('search-ms:query=test')).toEqual({
      ok: false,
      reason: 'denied'
    })
  })

  it('rejects invalid input', () => {
    expect(classifyExternalAppUrl('')).toEqual({ ok: false, reason: 'invalid' })
    expect(classifyExternalAppUrl('not a url')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('TERMINAL_WEB_AND_APP_URL_REGEX', () => {
  it('matches http and custom app URLs in text', () => {
    const text = 'see https://ex.com and obsidian://open?vault=v file.md'
    const matches = text.match(new RegExp(TERMINAL_WEB_AND_APP_URL_REGEX.source, 'g'))
    expect(matches).toEqual(expect.arrayContaining(['https://ex.com', 'obsidian://open?vault=v']))
  })

  it('does not linkify denied schemes', () => {
    const text =
      'file:///etc/passwd javascript:alert(1) chrome://settings data:text/html,hi smb://host/share jnlp://x/app.jnlp'
    const matches = text.match(new RegExp(TERMINAL_WEB_AND_APP_URL_REGEX.source, 'g'))
    expect(matches).toBeNull()
  })
})
