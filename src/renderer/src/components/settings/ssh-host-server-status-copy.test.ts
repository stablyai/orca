import { describe, expect, it } from 'vitest'
import { sshConnectFailureText, sshHostServerStatusLine } from './ssh-host-server-status-copy'

const plain = {}

describe('SSH host server status line', () => {
  it('says nothing for a plain host before any decision', () => {
    expect(sshHostServerStatusLine(plain, undefined)).toBeNull()
  })

  it('shows startup progress and preserves the cause of unverifiable server contact', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'starting' } })
        ?.text
    ).toBe('Starting managed server…')
    const detail = 'orcad did not become ready.\nLast lines of orcad.log:\nboom'
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: {
          kind: 'managed',
          environmentId: 'e',
          serving: { state: 'unverifiable', detail }
        }
      })
    ).toEqual({
      tone: 'warning',
      text: 'Orca couldn’t confirm that the managed server is answering.',
      detail
    })
  })

  it.each([
    'The managed Orca server process is live but is not answering.',
    'SSH operation was cancelled',
    'SSH transport closed before the server answered'
  ])('does not infer process exit from unverifiable contact: %s', (detail) => {
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: {
          kind: 'managed',
          environmentId: 'e',
          serving: { state: 'unverifiable', detail },
          update: { state: 'deferred', detail: 'Terminals are running.' }
        }
      })
    ).toEqual({
      tone: 'warning',
      text: 'Orca couldn’t confirm that the managed server is answering.',
      detail
    })
  })

  it('shows a managed server being updated, and why it kept its version', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'updating' } })
        ?.text
    ).toBe('Updating managed server…')
    const managed = (update: { state: 'host-newer' | 'deferred' | 'failed'; detail?: string }) =>
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'managed', environmentId: 'e', update }
      })
    expect(managed({ state: 'host-newer' })?.text).toContain('from a newer Orca')
    expect(managed({ state: 'deferred', detail: '2 terminals are running.' })).toMatchObject({
      tone: 'muted',
      detail: '2 terminals are running.'
    })
    expect(managed({ state: 'failed', detail: 'readiness timed out' })).toMatchObject({
      tone: 'warning',
      detail: 'readiness timed out'
    })
  })

  it('keeps durable reasons visible without a live state', () => {
    expect(sshHostServerStatusLine({ orcadFence: { environmentId: 'e' } }, undefined)).toBeNull()
    expect(
      sshHostServerStatusLine(
        { orcadFence: { environmentId: 'e', sourceChangedAt: '2026-10-05T00:00:00Z' } },
        { managedServer: { kind: 'managed', environmentId: 'e' } }
      )
    ).toMatchObject({ tone: 'warning' })
    expect(
      sshHostServerStatusLine(
        { managedServerUnavailable: { reason: 'native_preflight', appVersion: '1.5.0' } },
        undefined
      )?.text
    ).toContain('missing system libraries')
    expect(
      sshHostServerStatusLine(
        { managedServerUnavailable: { reason: 'future_reason', appVersion: '1.5.0' } },
        undefined
      )
    ).toMatchObject({ text: expect.not.stringContaining('future_reason'), detail: 'future_reason' })
  })

  it('tells an unsupported host to install an older Orca, never to fall back', () => {
    const line = sshHostServerStatusLine(plain, {
      managedServer: { kind: 'relay', reason: 'orcad_unavailable', detail: 'native_preflight' }
    })
    expect(line).toEqual({
      tone: 'destructive',
      text: 'This host isn’t supported by this version of Orca (the host is missing system libraries the server needs). To keep using it, install an older version of Orca.'
    })
    expect(line?.text).not.toContain('relay')
  })

  it('says plainly when neither port forwarding nor the SSH session reaches the server', () => {
    const live = sshHostServerStatusLine(plain, {
      managedServer: {
        kind: 'relay',
        reason: 'orcad_unavailable',
        detail: 'ssh_tunnel_unavailable'
      }
    })
    const recorded = sshHostServerStatusLine(
      { managedServerUnavailable: { reason: 'ssh_tunnel_unavailable', appVersion: '1.5.0' } },
      undefined
    )
    for (const line of [live, recorded]) {
      expect(line).toMatchObject({
        tone: 'destructive',
        text: expect.stringContaining('install an older version of Orca')
      })
    }
  })

  it('asks for a reconnect while an older Orca’s terminals still run, counting them', () => {
    const live = (terminals?: number) =>
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals }
      })?.text
    expect(live(1)).toBe(
      '1 terminal started by an older version of Orca is still running on this host, and it doesn’t stop on its own. Close it in that version of Orca or end it on the host, then reconnect.'
    )
    expect(live(2)).toContain('2 terminals started by an older version of Orca')
    // Why: an absent count is unreported, never zero open terminals.
    expect(live(undefined)).not.toMatch(/\d/)
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_unverifiable' }
      })?.text
    ).toContain('Reconnect to try again')
  })

  it('offers a failed setup’s log tail beside a try-again line', () => {
    const detail = 'No readiness line.\nLast lines of orcad.log:\nError: EADDRINUSE'
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'deferred', detail }
      })
    ).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('Try connecting again'),
      detail
    })
  })

  it('puts an unserved host’s translated reason in the connect toast', () => {
    const state = {
      managedServer: { kind: 'relay' as const, reason: 'orcad_unavailable' as const }
    }
    expect(sshConnectFailureText(plain, state, 'raw')).toContain('install an older version of Orca')
    expect(sshConnectFailureText(plain, undefined, 'raw')).toBe('raw')
  })
})
