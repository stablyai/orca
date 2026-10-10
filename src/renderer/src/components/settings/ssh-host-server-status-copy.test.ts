import { describe, expect, it } from 'vitest'
import { sshHostServerStatusLine } from './ssh-host-server-status-copy'

const plain = {}

describe('SSH host server status line', () => {
  it('says nothing for a plain host before any decision', () => {
    expect(sshHostServerStatusLine(plain, undefined)).toBeNull()
  })

  it('stays quiet for a healthy managed server, names setup progress and why a host stays on the relay', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'managed', environmentId: 'e' } })
    ).toBeNull()
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'converting' } })
        ?.text
    ).toContain('Moving this host')
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals: 3 }
      })?.text
    ).toContain('3 open terminals')
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'refused', detail: 'An automation runs here.' }
      })
    ).toMatchObject({ tone: 'destructive', detail: 'An automation runs here.' })
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live' }
      })?.text
    ).not.toMatch(/\d/)
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

  it('offers the move only while live relay terminals keep the host on the relay', () => {
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals: 3 }
      })
    ).toMatchObject({ action: 'move', text: expect.stringContaining('3 open terminals') })
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_unverifiable' }
      })
    ).not.toHaveProperty('action')
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'managed', environmentId: 'e' } })
    ).toBeNull()
  })

  it('offers the setup failure, log tail included, beside a retry line', () => {
    const detail = 'No readiness line.\nLast lines of orcad.log:\nError: EADDRINUSE'
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'deferred', detail }
      })
    ).toMatchObject({ tone: 'muted', detail })
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'relay', reason: 'failed' } })
    ).not.toHaveProperty('detail')
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

  it('names terminals another desktop runs, with no move action', () => {
    const line = sshHostServerStatusLine(plain, {
      managedServer: {
        kind: 'relay',
        reason: 'relay_terminals_live',
        terminals: 1,
        terminalsElsewhere: true
      }
    })
    expect(line?.text).toBe(
      'Runs the relay while 1 terminal another Orca desktop or session opened on this host is running.'
    )
    expect(line).not.toHaveProperty('action')
  })

  it('counts terminals in singular and plural on the status line', () => {
    const live = (terminals: number, terminalsElsewhere?: boolean) =>
      sshHostServerStatusLine(plain, {
        managedServer: {
          kind: 'relay',
          reason: 'relay_terminals_live',
          terminals,
          ...(terminalsElsewhere ? { terminalsElsewhere } : {})
        }
      })?.text
    expect(live(1)).toBe(
      'Runs the relay until its 1 open terminal is closed, then moves to a managed server.'
    )
    expect(live(2)).toBe(
      'Runs the relay until its 2 open terminals are closed, then moves to a managed server.'
    )
    expect(live(3, true)).toBe(
      'Runs the relay while 3 terminals another Orca desktop or session opened on this host are running.'
    )
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

  it('says plainly when neither port forwarding nor the SSH session reaches a managed server', () => {
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
        tone: 'warning',
        text: expect.stringContaining('doesn’t allow port forwarding')
      })
    }
  })
})
