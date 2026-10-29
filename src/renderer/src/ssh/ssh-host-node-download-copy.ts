import type {
  SshManagedServerNodeDownloadBlocked,
  SshManagedServerStatus
} from '../../../shared/ssh-types'
import type { NodeDistMirrorRefusal } from '../../../shared/node-dist-mirror'
import { translate } from '@/i18n/i18n'

/** `offer`: set a mirror now. `settings`: a mirror was tried, so only its setting is left. */
export type NodeMirrorRecovery = 'offer' | 'settings'

/** Use main’s structured flag; an already configured local mirror must not be overwritten by another offer. */
export function nodeMirrorRecovery(
  status: SshManagedServerStatus | undefined,
  configuredMirror: string | undefined
): NodeMirrorRecovery | null {
  const blocked = blockedNodeDownload(status)
  if (!blocked || blocked.mirror === 'unsupported') {
    return null
  }
  return blocked.mirror === 'unset' && !configuredMirror?.trim() ? 'offer' : 'settings'
}

/** The blocked download a failed setup reports; a held move or lost contact says something else. */
export function blockedNodeDownload(
  status: SshManagedServerStatus | undefined
): SshManagedServerNodeDownloadBlocked | null {
  if (
    status?.kind !== 'relay' ||
    status.reason !== 'failed' ||
    status.held ||
    status.contactLost ||
    !status.nodeDownloadBlocked
  ) {
    return null
  }
  return status.nodeDownloadBlocked
}

export function nodeDownloadBlockedText(blocked: SshManagedServerNodeDownloadBlocked): string {
  switch (blocked.mirror) {
    case 'unset':
      return translate(
        'auto.components.settings.sshHostServer.nodeDownloadBlocked',
        'Neither this computer nor this host could download Node.js, which Orca’s server needs. Use a Node.js mirror, or check the network on both machines.'
      )
    case 'unsupported':
      return translate(
        'auto.components.settings.sshHostServer.nodeDownloadBlockedNoMirror',
        'Neither this computer nor this host could download Node.js, which Orca’s server needs. Check the network or proxy on both machines, then connect again.'
      )
    case 'tried':
      return translate(
        'auto.components.settings.sshHostServer.nodeDownloadBlockedMirrorTried',
        'Neither this computer nor this host could download Node.js, including from the Node.js download mirror. Check the mirror setting, then connect again.'
      )
  }
}

export function nodeMirrorRecoveryLabel(recovery: NodeMirrorRecovery): string {
  return recovery === 'offer'
    ? translate('auto.components.settings.nodeDistMirrorDialog.action', 'Use a Node.js mirror…')
    : translate('auto.components.settings.nodeDistMirrorDialog.openSetting', 'Open mirror setting')
}

export function nodeDistMirrorRefusalText(reason: NodeDistMirrorRefusal): string {
  switch (reason) {
    case 'too-long':
      return translate(
        'auto.components.settings.nodeDistMirrorDialog.refusal.tooLong',
        'Mirror URL is too long.'
      )
    case 'protocol':
      return translate(
        'auto.components.settings.nodeDistMirrorDialog.refusal.protocol',
        'Use an http or https mirror URL.'
      )
    case 'credentials':
      return translate(
        'auto.components.settings.nodeDistMirrorDialog.refusal.credentials',
        'Mirror URL cannot contain a user name or password.'
      )
    case 'query':
      return translate(
        'auto.components.settings.nodeDistMirrorDialog.refusal.query',
        'Mirror URL cannot have a query or fragment.'
      )
    case 'invalid':
      return translate(
        'auto.components.settings.nodeDistMirrorDialog.refusal.invalid',
        'Enter a valid mirror URL.'
      )
  }
}
