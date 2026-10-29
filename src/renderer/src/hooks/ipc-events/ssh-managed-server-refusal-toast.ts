import { toast } from 'sonner'
import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { leaveBehindLine, REFUSAL_INLINE_CHARS } from '@/ssh/ssh-host-refused-move-copy'
import { useAppStore } from '../../store'

/** A refused move; when Move anyway clears it, say what stays behind and lead to the card that asks. */
export function toastSshHostMoveRefused(
  targetId: string,
  status: Extract<SshManagedServerStatus, { kind: 'relay' }>
): void {
  // Web clients can't run this desktop's Move anyway.
  if (!canOfferMoveAnywayToast(status)) {
    toast.error(
      translate(
        'auto.hooks.ipcEvents.sshManagedServer.refusedBlocked',
        'Orca couldn’t set itself up on this SSH host. SSH Hosts in Settings shows why.'
      )
    )
    return
  }
  // A warning like the card line, kept until acted on or dismissed: it carries the way out.
  toast.warning(leaveBehindLine(status.detail, REFUSAL_INLINE_CHARS).text, {
    duration: Number.POSITIVE_INFINITY,
    // The rejected connect toasts too; one id keeps a single toast that still offers Move anyway.
    id: sshHostMoveRefusedToastId(targetId),
    action: {
      label: translate('auto.components.settings.moveAnyway.action', 'Move anyway…'),
      onClick: () => {
        const store = useAppStore.getState()
        store.openSettingsTarget({ pane: 'ssh', repoId: null })
        store.openSettingsPage()
      }
    }
  })
}

export function sshHostMoveRefusedToastId(targetId: string): string {
  return `ssh-host-move-refused:${targetId}`
}

export function canOfferMoveAnywayToast(
  status: SshManagedServerStatus | undefined
): status is Extract<SshManagedServerStatus, { kind: 'relay' }> {
  return (
    status?.kind === 'relay' &&
    status.reason === 'refused' &&
    Boolean(status.canLeaveBehind) &&
    !isWebClientLocation()
  )
}
