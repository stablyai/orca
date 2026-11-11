import { describe, expect, it } from 'vitest'
import type { RemoteDesktopPageState } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'
import { deriveCloudDesktopPhase, desktopNeedsSession } from './use-cloud-desktop-connection'

const page = (patch: Partial<RemoteDesktopPageState>): RemoteDesktopPageState => ({
  browserPageId: 'p',
  desktop: true,
  captured: false,
  connection: 'connecting',
  ...patch
})
const idle = { status: 'idle' as const, tries: 0 }

describe('remote desktop tab phase', () => {
  it('shows the sandbox state first: asleep, waking, archived, couldn’t wake', () => {
    const connected = page({ connection: 'connected' })
    const phase = (sandbox: string) =>
      deriveCloudDesktopPhase({ isCloud: true, sandbox, page: connected, attempt: idle }).kind
    expect(phase('sleeping')).toBe('asleep')
    expect(phase('waking')).toBe('waking')
    expect(phase('starting')).toBe('waking')
    expect(phase('archived')).toBe('archived')
    expect(phase('wakeFailed')).toBe('wakeFailed')
    expect(phase('running')).toBe('connected')
  })

  it('reconnects a page with no session once the sandbox is up', () => {
    const none = page({ desktop: false, connection: 'none' })
    expect(desktopNeedsSession(none)).toBe(true)
    expect(
      deriveCloudDesktopPhase({ isCloud: true, sandbox: 'running', page: none, attempt: idle })
    ).toEqual({ kind: 'reconnecting' })
  })

  it('treats a page paused because the sandbox slept as needing a new session', () => {
    expect(desktopNeedsSession(page({ connection: 'paused', reason: 'asleep' }))).toBe(true)
    expect(desktopNeedsSession(page({ connection: 'paused', reason: 'starting' }))).toBe(true)
    // A dropped connection the page itself offers Reconnect for stays the page's to show.
    expect(desktopNeedsSession(page({ connection: 'paused', reason: 'failed' }))).toBe(false)
    expect(
      deriveCloudDesktopPhase({
        isCloud: true,
        sandbox: 'running',
        page: page({ connection: 'paused', reason: 'failed' }),
        attempt: idle
      })
    ).toEqual({ kind: 'paused', reason: 'failed' })
  })

  it('names a failed reopen, and reads "not running" as asleep', () => {
    const none = page({ desktop: false, connection: 'none' })
    expect(
      deriveCloudDesktopPhase({
        isCloud: true,
        sandbox: 'running',
        page: none,
        attempt: { status: 'failed', tries: 1, code: 'forward_failed' }
      })
    ).toEqual({ kind: 'failed', code: 'forward_failed' })
    expect(
      deriveCloudDesktopPhase({
        isCloud: true,
        sandbox: 'unknown',
        page: none,
        attempt: { status: 'failed', tries: 1, code: 'not_running' }
      })
    ).toEqual({ kind: 'asleep' })
  })

  it('stops after the automatic attempts and offers Reconnect', () => {
    expect(
      deriveCloudDesktopPhase({
        isCloud: true,
        sandbox: 'running',
        page: page({ desktop: false, connection: 'none' }),
        attempt: { status: 'idle', tries: 3 }
      }).kind
    ).toBe('failed')
  })

  it('waits for main before saying anything about a fresh page', () => {
    expect(
      deriveCloudDesktopPhase({ isCloud: true, sandbox: 'running', page: null, attempt: idle })
    ).toEqual({ kind: 'connecting' })
  })
})
