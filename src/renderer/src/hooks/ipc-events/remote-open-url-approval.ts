import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type {
  RemoteOpenUrlApprovalResult,
  RemoteOpenUrlRequestEvent
} from '../../../../shared/remote-open-url'

type ApprovalState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'sshTargetLabels' | 'removedSshTargetLabels'
>

export type RemoteOpenUrlRequest = Pick<RemoteOpenUrlRequestEvent, 'url' | 'sshTargetId'>

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
export function showRemoteOpenUrlApproval(request: RemoteOpenUrlRequestEvent): void {
  const described = describeRemoteOpenUrlRequest(request, useAppStore.getState())
  if (!described) {
    return
  }
  const description =
    request.callbackPort === null
      ? request.url
      : `${request.url}\n${translate(
          'remoteOpenUrl.forwardNotice',
          'Sign-in returns to {{value0}} through a temporary forward of 127.0.0.1:{{value1}} (up to 5 min).',
          { value0: described.hostLabel, value1: String(request.callbackPort) }
        )}`
  toast(
    translate('remoteOpenUrl.title', '{{value0}} wants to open {{value1}}', {
      value0: described.hostLabel,
      value1: described.site
    }),
    {
      description,
      duration: 120_000,
      // Why: the forward notice is a second line under the URL; toasts collapse newlines by default.
      classNames: { description: 'whitespace-pre-line' },
      action: {
        label: translate('remoteOpenUrl.open', 'Open'),
        onClick: () => {
          void window.api.ui
            .approveRemoteOpenUrl(request.requestId)
            .then((result) => reportApproval(result, described.hostLabel))
            .catch(() => reportApproval({ status: 'expired' }, described.hostLabel))
        }
      },
      cancel: {
        label: translate('remoteOpenUrl.dismiss', 'Dismiss'),
        onClick: () => {}
      }
    }
  )
}

function reportApproval(result: RemoteOpenUrlApprovalResult, hostLabel: string): void {
  if (result.status === 'opened') {
    if (result.forwardedPort !== null) {
      toast.info(
        translate(
          'remoteOpenUrl.forwarding',
          'Forwarding 127.0.0.1:{{value0}} to {{value1}} until sign-in returns (up to {{value2}} min).',
          {
            value0: String(result.forwardedPort),
            value1: hostLabel,
            value2: String(result.forwardMinutes ?? 5)
          }
        )
      )
    }
    return
  }
  if (result.status === 'expired') {
    toast.error(
      translate('remoteOpenUrl.expired', 'This request expired. Run the command on the host again.')
    )
    return
  }
  toast.error(
    result.reason === 'port_in_use'
      ? translate(
          'remoteOpenUrl.portInUse',
          'Port {{value0}} is already in use on this computer, so the sign-in cannot return to {{value1}}. Close what uses it and try again.',
          { value0: String(result.port), value1: hostLabel }
        )
      : translate(
          'remoteOpenUrl.forwardUnavailable',
          'Could not forward the sign-in back to {{value0}}. Check the SSH connection and try again.',
          { value0: hostLabel }
        )
  )
}
