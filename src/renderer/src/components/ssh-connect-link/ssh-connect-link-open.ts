import { create } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { canConnectSshStatus } from '@/ssh/ssh-connection-recoverability'
import { syncSshConfigTargetsPassively } from '@/runtime/hosts/ssh/ssh-config-passive-sync'
import { parseSshConnectLink } from '../../../../shared/remote-runtime/ssh/ssh-connect-link'
import { normalizeSshConfigAlias } from '../../../../shared/remote-runtime/ssh/ssh-config-alias'
import type { SshTarget } from '../../../../shared/remote-runtime/ssh/ssh-types'

/** A linked host waiting for the user's Connect; nothing connects before it. */
export type SshConnectLinkRequest = { alias: string; targetId: string; endpoint: string }

export const useSshConnectLinkStore = create<{ request: SshConnectLinkRequest | null }>()(() => ({
  request: null
}))

function findTargetByAlias(targets: readonly SshTarget[], alias: string): SshTarget | undefined {
  const normalized = normalizeSshConfigAlias(alias)
  return targets.find(
    (target) => normalizeSshConfigAlias(target.configHost ?? target.label) === normalized
  )
}

function openSshSettings(): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane: 'ssh', repoId: null })
  store.openSettingsPage()
}

/** An `orca://ssh/connect?alias=…` link: finds the host and asks before connecting; never connects itself. */
export function openSshConnectLink(raw: string): void {
  void requestSshConnect(raw).catch((error: unknown) =>
    console.error('Failed to open the SSH link:', error)
  )
}

async function requestSshConnect(raw: string): Promise<void> {
  const link = parseSshConnectLink(raw)
  if (!link) {
    toast.error(translate('sshConnectLink.invalid', 'That SSH link isn’t valid.'), {
      id: 'ssh-connect-link-invalid'
    })
    return
  }
  let target = findTargetByAlias(await window.api.ssh.listTargets(), link.alias)
  if (!target) {
    // The app that wrote this host opens the link right after; a deleted host stays deleted.
    await syncSshConfigTargetsPassively({ fresh: true })
    target = findTargetByAlias(await window.api.ssh.listTargets(), link.alias)
  }
  if (!target) {
    toast.error(
      translate('sshConnectLink.notFound', 'No SSH host named {{alias}}', { alias: link.alias }),
      {
        id: 'ssh-connect-link-not-found',
        description: translate(
          'sshConnectLink.notFoundDetail',
          'It isn’t in ~/.ssh/config, or it was removed from Orca. Removed hosts can be restored in SSH settings.'
        ),
        action: {
          label: translate('sshConnectLink.openSettings', 'Open SSH settings'),
          onClick: openSshSettings
        }
      }
    )
    return
  }
  const status = useAppStore.getState().sshConnectionStates.get(target.id)?.status
  // Connected or connecting already: nothing new to trust.
  if (status && !canConnectSshStatus(status)) {
    return
  }
  // Show where connect goes: config hosts follow `ssh -G`, manual ones keep their saved address.
  const resolved =
    target.source === 'manual'
      ? null
      : await window.api.ssh.resolveConfigHost({ alias: link.alias }).catch(() => null)
  const endpoint = resolved
    ? `${resolved.hostname}:${resolved.port}`
    : `${target.host}:${target.port}`
  if (useSshConnectLinkStore.getState().request?.targetId !== target.id) {
    useSshConnectLinkStore.setState({
      request: { alias: link.alias, targetId: target.id, endpoint }
    })
  }
}

export function closeSshConnectLink(request: SshConnectLinkRequest): void {
  if (useSshConnectLinkStore.getState().request === request) {
    useSshConnectLinkStore.setState({ request: null })
  }
}
