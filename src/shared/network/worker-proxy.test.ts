import { describe, expect, it } from 'vitest'
import { WorkerStartParams } from '../rpc-contract/orchestration/orchestration-worker-start-params'
import {
  buildWorkerProxyEnv,
  ORCA_LAUNCH_PROXY_ENV,
  parseWorkerProxyUrl,
  redactWorkerProxyUrl
} from './worker-proxy'

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
]

describe('worker proxy', () => {
  it.each([
    'http://proxy.example:8080',
    'https://proxy.example:8443',
    'socks5://proxy.example:1080',
    'socks5h://user:secret@proxy.example:1080'
  ])('points every proxy variable at %s', (url) => {
    const env = buildWorkerProxyEnv(url)
    for (const key of PROXY_KEYS) {
      expect(env[key]).toBe(url)
    }
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
    expect(env[ORCA_LAUNCH_PROXY_ENV]).toBe('1')
  })

  it('adds bypass hosts after loopback without duplicates', () => {
    const env = buildWorkerProxyEnv(
      'http://proxy.example:8080',
      'corp.internal; localhost,\n10.0.0.0/8'
    )
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,corp.internal,10.0.0.0/8')
  })

  it.each([
    'ftp://proxy.example:21',
    'socks4://proxy.example:1080',
    'file:///etc/passwd',
    'http://proxy.example:8080/path',
    'http://proxy.example:8080?x=1',
    'not a url',
    ''
  ])('rejects %s', (url) => {
    expect(parseWorkerProxyUrl(url).ok).toBe(false)
  })

  it('masks credentials for http and socks URLs', () => {
    expect(redactWorkerProxyUrl('http://user:secret@proxy.example:8080')).toBe(
      'http://***:***@proxy.example:8080'
    )
    expect(redactWorkerProxyUrl('socks5h://user:secret@proxy.example:1080')).toBe(
      'socks5h://***:***@proxy.example:1080'
    )
    expect(redactWorkerProxyUrl('socks5://token@proxy.example:1080')).toBe(
      'socks5://***@proxy.example:1080'
    )
    expect(redactWorkerProxyUrl('ftp://user:secret@proxy.example')).not.toContain('secret')
  })

  it('refuses a bad proxy at the RPC boundary without echoing its credentials', () => {
    const parsed = WorkerStartParams.safeParse({
      from: 'term_1',
      spec: 'do it',
      proxy: 'ftp://user:secret@proxy.example:21'
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('secret')
  })

  it('never sends a proxy to another server or a reused terminal', () => {
    const base = {
      from: 'term_1',
      spec: 'do it',
      proxy: 'socks5h://user:secret@proxy.example:1080'
    }
    expect(WorkerStartParams.safeParse(base).success).toBe(true)
    expect(WorkerStartParams.safeParse({ ...base, on: 'server-1' }).success).toBe(false)
    expect(WorkerStartParams.safeParse({ ...base, terminal: 'term_2' }).success).toBe(false)
  })
})
