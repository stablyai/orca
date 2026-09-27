import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'

type ApprovalState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'sshTargetLabels' | 'removedSshTargetLabels'
>

export type RemoteOpenUrlRequest = { url: string; sshTargetId: string }

/**
 * Names the requesting machine and the site, for a prompt the owner can judge at a glance.
 * The target id comes from the desktop-side SSH session, so the named host cannot be spoofed.
 */
export function describeRemoteOpenUrlRequest(
  request: RemoteOpenUrlRequest,
  state: ApprovalState
): { hostLabel: string; site: string } | null {
  let site: string
  try {
    const parsed = new URL(request.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    site = parsed.host
  } catch {
    return null
  }
  const hostLabel =
    state.sshTargetLabels?.get(request.sshTargetId)?.trim() ||
    state.removedSshTargetLabels?.get(request.sshTargetId)?.trim() ||
    request.sshTargetId
  return { hostLabel, site }
}

// Why a prompt and not an automatic open: the remote host is less trusted than this desktop,
// so the owner decides; the page then opens in the system browser, where logins work.
export function showRemoteOpenUrlApproval(request: RemoteOpenUrlRequest): void {
  const described = describeRemoteOpenUrlRequest(request, useAppStore.getState())
  if (!described) {
    return
  }
  toast(
    translate('remoteOpenUrl.title', '{{value0}} wants to open {{value1}}', {
      value0: described.hostLabel,
      value1: described.site
    }),
    {
      description: request.url,
      duration: 120_000,
      action: {
        label: translate('remoteOpenUrl.open', 'Open'),
        onClick: () => {
          void window.api.shell.openUrl(request.url)
        }
      },
      cancel: {
        label: translate('remoteOpenUrl.dismiss', 'Dismiss'),
        onClick: () => {}
      }
    }
  )
}
