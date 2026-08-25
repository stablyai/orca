import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getEndpointFileName,
  isShellSafeEndpointValue,
  writeEndpointFile
} from './agent-hook-listener/endpoint-publication'
import {
  HOOK_REQUEST_MAX_BYTES,
  parseFormEncodedBody,
  readRequestBody
} from './agent-hook-listener/request-body'
import { resolveHookSource } from './agent-hook-listener/source-routing'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'

type FakeIncomingMessage = EventEmitter & {
  headers: IncomingHttpHeaders
  destroy: ReturnType<typeof vi.fn>
}

function createReadableRequest(headers: IncomingHttpHeaders = {}): FakeIncomingMessage {
  const req = new EventEmitter() as FakeIncomingMessage
  req.headers = headers
  req.destroy = vi.fn(() => req.emit('close'))
  return req
}

function expectRequestParserListenersReleased(req: FakeIncomingMessage): void {
  expect(req.listenerCount('data')).toBe(0)
  expect(req.listenerCount('end')).toBe(0)
  expect(req.listenerCount('close')).toBe(0)
  expect(req.listenerCount('error')).toBe(1)
  expect(() => req.emit('error', new Error('late request error'))).not.toThrow()
}

describe('shared agent-hook-listener', () => {
  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it('parses form-encoded bodies', () => {
    const decoded = parseFormEncodedBody('paneKey=tab-1%3A0&worktreeId=foo')
    expect(decoded.paneKey).toBe('tab-1:0')
    expect(decoded.worktreeId).toBe('foo')
  })

  it('releases request parser listeners after reading a JSON body', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)

    req.emit('data', Buffer.from('{"ok":true}'))
    req.emit('end')

    await expect(body).resolves.toEqual({ ok: true })
    expectRequestParserListenersReleased(req)
  })

  it('releases request parser listeners after rejecting an oversized body', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)

    req.emit('data', Buffer.alloc(HOOK_REQUEST_MAX_BYTES + 1))

    await expect(body).rejects.toThrow('payload too large')
    expect(req.destroy).toHaveBeenCalledTimes(1)
    expectRequestParserListenersReleased(req)
  })

  it('accepts a JSON body at exactly the byte limit', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const text = JSON.stringify({ x: 'a'.repeat(HOOK_REQUEST_MAX_BYTES - 8) })
    expect(Buffer.byteLength(text)).toBe(HOOK_REQUEST_MAX_BYTES)
    const body = readRequestBody(req as unknown as IncomingMessage)

    req.emit('data', Buffer.from(text))
    req.emit('end')

    await expect(body).resolves.toEqual({ x: 'a'.repeat(HOOK_REQUEST_MAX_BYTES - 8) })
    expectRequestParserListenersReleased(req)
  })

  it('strips exactly one outer JSON BOM', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)
    req.emit('data', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]))
    req.emit('end')
    await expect(body).resolves.toEqual({ ok: true })
  })

  it('rejects JSON beyond the nesting-depth limit', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)
    req.emit('data', Buffer.from(`${'['.repeat(65)}0${']'.repeat(65)}`))
    req.emit('end')
    await expect(body).rejects.toThrow('JSON nesting exceeds 64 levels')
    expectRequestParserListenersReleased(req)
  })

  it('rejects JSON beyond the 128K structural-token limit', async () => {
    const req = createReadableRequest({ 'content-type': 'application/json' })
    const body = readRequestBody(req as unknown as IncomingMessage)
    req.emit('data', Buffer.from(`[${'0,'.repeat(128 * 1024)}0]`))
    req.emit('end')
    await expect(body).rejects.toThrow('JSON structure exceeds 131072 tokens')
    expectRequestParserListenersReleased(req)
  })

  it('classifies a premature request error before its original error', async () => {
    const req = createReadableRequest({ 'content-length': '10' })
    const body = readRequestBody(req as unknown as IncomingMessage)
    req.emit('data', Buffer.from('ab'))
    req.emit('error', new Error('socket reset'))
    await expect(body).rejects.toThrow('hook request truncated after 2 of 10 bytes')
    expectRequestParserListenersReleased(req)
  })

  it('settles a premature close once and ignores late request events', async () => {
    const req = createReadableRequest({ 'content-length': '10' })
    const body = readRequestBody(req as unknown as IncomingMessage)
    req.emit('data', Buffer.from('ab'))
    req.emit('close')
    req.emit('end')
    await expect(body).rejects.toThrow('hook request truncated after 2 of 10 bytes')
    expectRequestParserListenersReleased(req)
  })

  it('routes pathnames to a known source or null', () => {
    expect(resolveHookSource('/hook/claude')).toBe('claude')
    expect(resolveHookSource('/hook/cursor')).toBe('cursor')
    expect(resolveHookSource('/hook/antigravity')).toBe('antigravity')
    expect(resolveHookSource('/hook/grok')).toBe('grok')
    expect(resolveHookSource('/hook/hermes')).toBe('hermes')
    expect(resolveHookSource('/hook/pi')).toBe('pi')
    expect(resolveHookSource('/hook/omp')).toBe('omp')
    expect(resolveHookSource('/hook/prime-agent')).toBe('prime-agent')
    expect(resolveHookSource('/hook/command-code')).toBe('command-code')
    expect(resolveHookSource('/hook/mimo-code')).toBe('mimo-code')
    expect(resolveHookSource('/hook/unknown')).toBeNull()
    expect(resolveHookSource('/')).toBeNull()
  })

  it('rejects shell-unsafe endpoint values', () => {
    expect(isShellSafeEndpointValue('1234')).toBe(true)
    expect(isShellSafeEndpointValue('abc-DEF.0_1')).toBe(true)
    expect(isShellSafeEndpointValue('')).toBe(false)
    expect(isShellSafeEndpointValue('foo&bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo bar')).toBe(false)
    expect(isShellSafeEndpointValue('foo;bar')).toBe(false)
  })

  describe('writeEndpointFile', () => {
    let dir: string
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agent-hook-listener-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes the endpoint file atomically with the right contents and mode', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'abcdef-0123',
        env: 'production',
        version: '1'
      })
      expect(ok).toBe(true)
      const text = readFileSync(finalPath, 'utf8')
      expect(text).toContain('ORCA_AGENT_HOOK_PORT=12345')
      expect(text).toContain('ORCA_AGENT_HOOK_TOKEN=abcdef-0123')
      expect(text).toContain('ORCA_AGENT_HOOK_VERSION=1')
      // POSIX 0o600 — owner read/write only.
      if (process.platform !== 'win32') {
        const mode = statSync(finalPath).mode & 0o777
        expect(mode).toBe(0o600)
      }
    })

    it('refuses unsafe values', () => {
      const finalPath = join(dir, getEndpointFileName())
      const ok = writeEndpointFile(dir, finalPath, {
        port: 12345,
        token: 'safe-token',
        env: 'foo&bar',
        version: '1'
      })
      expect(ok).toBe(false)
    })
  })
})
