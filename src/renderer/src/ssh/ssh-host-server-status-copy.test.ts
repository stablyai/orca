import { describe, expect, it } from 'vitest'
import type { SshManagedServerUpdateNote } from '../../../shared/ssh-types'
import { sshConnectFailureText, sshHostServerStatusLine } from './ssh-host-server-status-copy'

const plain = { label: 'Box' }

describe('SSH host server status line', () => {
  it('says nothing for a plain host before any decision', () => {
    expect(sshHostServerStatusLine(plain, undefined)).toBeNull()
  })

  it('names the host while setting up and says the code stays where it is', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'converting' } })
    ).toEqual({
      tone: 'muted',
      text: 'Moving to Orca on Box…',
      hint: 'Runs on Box, reached over your own SSH connection. Your code and files stay where they are. Only Orca’s list of projects, tabs and terminals moves to Box.'
    })
    // A reconnect of a host that already moved starts its server; nothing moves then.
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'starting' } })
    ).toEqual({ tone: 'muted', text: 'Starting Orca on Box…' })
  })

  it('shows startup progress and preserves the cause of unverifiable server contact', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'starting' } })
        ?.text
    ).toBe('Starting Orca on Box…')
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
      text: 'Orca couldn’t confirm that its server on Box is answering.',
      detail
    })
  })

  it.each([
    'This host’s Orca server process is live but is not answering.',
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
      text: 'Orca couldn’t confirm that its server on Box is answering.',
      detail
    })
  })

  it('warns when the SSH session that started a macOS host’s server ended', () => {
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'managed', environmentId: 'e', launchSessionEnded: true }
      })
    ).toEqual({
      tone: 'warning',
      text: 'Terminals on this Mac may have lost local network access because the SSH session that started this host’s Orca server ended. Restart Orca’s server to restore it.'
    })
  })

  it('shows a managed server being updated, and why it kept its version', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'updating' } })
        ?.text
    ).toBe('Updating Orca on Box…')
    const managed = (update: SshManagedServerUpdateNote) =>
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'managed', environmentId: 'e', update }
      })
    expect(managed({ state: 'host-newer' })?.text).toContain('newer version of Orca’s server')
    expect(managed({ state: 'deferred', detail: '2 terminals are running.' })).toMatchObject({
      tone: 'muted',
      detail: '2 terminals are running.'
    })
    expect(managed({ state: 'failed', detail: 'readiness timed out' })).toMatchObject({
      tone: 'warning',
      detail: 'readiness timed out'
    })
  })

  it('says a managed server may be behind this app, whatever kept it there', () => {
    const line = (update: SshManagedServerUpdateNote) =>
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'managed', environmentId: 'e', update }
      })
    expect(line({ state: 'rolled-back' })).toMatchObject({ tone: 'warning' })
    expect(line({ state: 'rolled-back' })?.text).toContain('Update server')
    expect(line({ state: 'no-template' })?.text).toContain('can’t update')
    expect(line({ state: 'migrating' })?.text).toContain('project move')
    expect(line({ state: 'check-failed', detail: 'ssh dropped' })).toMatchObject({
      tone: 'warning',
      detail: 'ssh dropped'
    })
  })

  it('says which projects the server already had, and what of this desktop’s stayed behind', () => {
    const linked = (automations: number) =>
      sshHostServerStatusLine(plain, {
        managedServer: {
          kind: 'managed',
          environmentId: 'e',
          linked: [
            { path: '/root/app', automations },
            { path: '/root/tool', automations: 0 }
          ]
        }
      })
    expect(linked(2)).toEqual({
      tone: 'warning',
      text: 'This host’s Orca server already had /root/app, /root/tool, so this desktop now uses the server’s copy. This desktop’s tabs and 2 automations there were not moved, and worktrees it created there show as external worktrees.'
    })
    expect(linked(0)?.text).not.toContain('automation')
  })

  it('keeps durable reasons visible without a live state', () => {
    expect(
      sshHostServerStatusLine({ label: 'Box', orcadFence: { environmentId: 'e' } }, undefined)
    ).toBeNull()
    expect(
      sshHostServerStatusLine(
        {
          label: 'Box',
          orcadFence: { environmentId: 'e', sourceChangedAt: '2026-10-05T00:00:00Z' }
        },
        { managedServer: { kind: 'managed', environmentId: 'e' } }
      )
    ).toMatchObject({ tone: 'warning' })
    expect(
      sshHostServerStatusLine(
        {
          label: 'Box',
          managedServerUnavailable: { reason: 'native_preflight', appVersion: '1.5.0' }
        },
        undefined
      )?.text
    ).toContain('missing system libraries')
    expect(
      sshHostServerStatusLine(
        {
          label: 'Box',
          managedServerUnavailable: { reason: 'future_reason', appVersion: '1.5.0' }
        },
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

  it('tells a noexec host what to change, not to install an older Orca', () => {
    const line = sshHostServerStatusLine(plain, {
      managedServer: { kind: 'relay', reason: 'orcad_unavailable', detail: 'runtime_noexec' }
    })
    expect(line).toMatchObject({ tone: 'destructive', text: expect.stringContaining('noexec') })
    expect(line?.text).toContain('connect again')
    expect(line?.text).not.toContain('older version')
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
      {
        label: 'Box',
        managedServerUnavailable: { reason: 'ssh_tunnel_unavailable', appVersion: '1.5.0' }
      },
      undefined
    )
    for (const line of [live, recorded]) {
      expect(line).toMatchObject({
        tone: 'destructive',
        text: expect.stringContaining('install an older version of Orca')
      })
    }
  })

  it('names the relay terminals that keep a bridged host unmoved, and how to clear them', () => {
    const line = sshHostServerStatusLine(plain, {
      managedServer: {
        kind: 'relay',
        reason: 'relay_terminals_live',
        terminals: 1,
        bridged: true,
        detail: 'Terminals an older version of Orca started in /root/repo are still running…'
      }
    })
    expect(line).toMatchObject({ tone: 'warning' })
    expect(line?.text).toContain('They keep working here')
    expect(line?.text).toContain('Close them or end them on the host, then reconnect')
    expect(line?.detail).toContain('/root/repo')
    const unverifiable = sshHostServerStatusLine(plain, {
      managedServer: { kind: 'relay', reason: 'relay_terminals_unverifiable', bridged: true }
    })
    expect(unverifiable?.text).toContain('couldn’t confirm')
    expect(unverifiable?.text).not.toContain('They keep working here')
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

  it('says contact was lost, not that the server failed, when setup lost the host', () => {
    const line = sshHostServerStatusLine(plain, {
      managedServer: {
        kind: 'relay',
        reason: 'failed',
        contactLost: true,
        detail: 'The SSH connection closed before the transfer finished'
      }
    })
    expect(line).toMatchObject({ tone: 'warning', text: expect.stringContaining('lost contact') })
    expect(line?.text).not.toContain('couldn’t start')
  })

  it('says a move that stopped short is paused and kept, not a plain try-again', () => {
    const detail = 'Could not connect to the remote Orca runtime.'
    const state = {
      managedServer: {
        kind: 'relay' as const,
        reason: 'failed' as const,
        detail,
        held: true as const
      }
    }
    expect(sshHostServerStatusLine(plain, state)).toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('Nothing is lost'),
      detail
    })
    expect(sshConnectFailureText(state, 'raw')).toContain('Settings > Orca on your SSH hosts')
  })

  it('puts an unserved host’s translated reason in the connect toast', () => {
    const state = {
      managedServer: { kind: 'relay' as const, reason: 'orcad_unavailable' as const }
    }
    expect(sshConnectFailureText(state, 'raw')).toContain('install an older version of Orca')
    expect(sshConnectFailureText(undefined, 'raw')).toBe('raw')
  })

  it('names what refuses the move, in the status line and the connect toast', () => {
    const detail =
      'This host’s Orca server already holds different saved state for something this desktop is moving, so nothing was moved and this desktop keeps its projects. Retrying won’t clear it. (orcad_migration_client_state_conflict:ui:workspaceHostScope)'
    const state = {
      managedServer: { kind: 'relay' as const, reason: 'refused' as const, detail }
    }
    const line = sshHostServerStatusLine(plain, state)
    expect(line).toMatchObject({ tone: 'destructive', detail })
    expect(line?.text).toContain('workspaceHostScope')
    expect(line?.text).not.toContain('something on the host stops the move')
    expect(sshConnectFailureText(state, 'raw')).toContain('already holds different saved state')
  })

  it('caps a long refusal in the Settings row, but not where there is no Details', () => {
    const detail = `This SSH host cannot move yet: ${'saved tabs and panes (a); '.repeat(60)}then connect again.`
    const state = { managedServer: { kind: 'relay' as const, reason: 'refused' as const, detail } }
    const line = sshHostServerStatusLine(plain, state)
    expect(line?.detail).toBe(detail)
    expect(line?.text.length).toBeLessThan(400)
    expect(line?.text).toContain('This SSH host cannot move yet')
    // The terminal pane and toast keep the way out, which comes last.
    expect(sshConnectFailureText(state, 'raw')).toContain('then connect again.')
  })

  it('keeps the plain refusal line when main named no reason', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'relay', reason: 'refused' } })?.text
    ).toContain('Orca isn’t set up on this host yet')
  })

  it('says a host an older Orca changed is blocked until moved, not served by the relay', () => {
    const changed = sshHostServerStatusLine(
      { label: 'Box', orcadFence: { environmentId: 'e', sourceChangedAt: '2026-10-05T00:00:00Z' } },
      undefined
    )
    const unserved = sshConnectFailureText(
      { managedServer: { kind: 'relay', reason: 'source_changed' } },
      'raw'
    )
    for (const text of [changed?.text, unserved]) {
      expect(text).toContain('to connect again')
      expect(text).not.toContain('relay')
    }
  })
})
