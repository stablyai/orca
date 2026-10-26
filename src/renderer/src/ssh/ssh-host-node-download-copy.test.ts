import { describe, expect, it } from 'vitest'
import type { SshManagedServerStatus } from '../../../shared/ssh-types'
import { nodeMirrorRecovery } from './ssh-host-node-download-copy'
import { sshConnectFailureText, sshHostServerStatusLine } from './ssh-host-server-status-copy'

const DETAIL =
  'Neither this computer nor the host could download Node from https://nodejs.org/dist/x.'

function blocked(
  mirror: 'unset' | 'tried' | 'unsupported',
  extra: Partial<Extract<SshManagedServerStatus, { kind: 'relay' }>> = {}
): SshManagedServerStatus {
  return {
    kind: 'relay',
    reason: 'failed',
    detail: DETAIL,
    nodeDownloadBlocked: { mirror },
    ...extra
  }
}

describe('Node.js mirror recovery for a setup that could not download Node', () => {
  it('offers a mirror only when none was in the failed attempts or is set now', () => {
    expect(nodeMirrorRecovery(blocked('unset'), '')).toBe('offer')
    expect(nodeMirrorRecovery(blocked('unset'), undefined)).toBe('offer')
    expect(nodeMirrorRecovery(blocked('unset'), 'https://mirror.example/node')).toBe('settings')
    expect(nodeMirrorRecovery(blocked('tried'), '')).toBe('settings')
  })

  it.each<[string, SshManagedServerStatus | undefined]>([
    ['no status', undefined],
    ['a build no mirror carries', blocked('unsupported')],
    ['a plain failure', { kind: 'relay', reason: 'failed', detail: DETAIL }],
    ['lost contact', blocked('unset', { contactLost: true })],
    ['a held move', blocked('unset', { held: true })],
    ['a refusal', blocked('unset', { reason: 'refused' })],
    ['a managed server', { kind: 'managed', environmentId: 'env-1' }]
  ])('offers nothing for %s', (_label, status) => {
    expect(nodeMirrorRecovery(status, '')).toBeNull()
  })

  it('never reads the failure from its text', () => {
    expect(nodeMirrorRecovery({ kind: 'relay', reason: 'failed', detail: DETAIL }, '')).toBeNull()
  })

  it('names the blocked download on the host row and in the connect toast', () => {
    const line = sshHostServerStatusLine({ label: 'Box' }, { managedServer: blocked('unset') })
    expect(line).toEqual({
      tone: 'destructive',
      text: expect.stringContaining('Use a Node.js mirror'),
      detail: DETAIL
    })
    expect(sshConnectFailureText({ managedServer: blocked('tried') }, 'fallback')).toContain(
      'Check the mirror setting'
    )
    expect(
      sshHostServerStatusLine({ label: 'Box' }, { managedServer: blocked('unsupported') })?.text
    ).not.toContain('mirror')
  })

  it('keeps the held-move and lost-contact lines ahead of the download', () => {
    expect(
      sshHostServerStatusLine({ label: 'Box' }, { managedServer: blocked('unset', { held: true }) })
        ?.text
    ).toContain('paused moving')
    expect(
      sshHostServerStatusLine(
        { label: 'Box' },
        { managedServer: blocked('unset', { contactLost: true }) }
      )?.text
    ).toContain('lost contact')
  })
})
