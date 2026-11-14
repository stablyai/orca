import { toast } from 'sonner'
import type { DesktopBrowserBridgeHostNotice } from '../../../../../shared/desktop-browser-bridge-host-control-contract'
import { translate } from '@/i18n/i18n'

export type RemoteHostBrowserControlActions = {
  stop: (targetId: string) => Promise<void>
  disallow: (targetId: string) => Promise<boolean>
}

export function remoteHostBrowserControlNoticeId(targetId: string): string {
  return `remote-host-browser-control:${targetId}`
}

/** Non-blocking: the host keeps working unless the person answers Stop or Don't allow. */
export function showRemoteHostBrowserControlNotice(
  notice: DesktopBrowserBridgeHostNotice,
  actions: RemoteHostBrowserControlActions
): void {
  const host = notice.hostLabel
  const stopped = (): void => {
    toast.success(
      translate(
        'remoteHostBrowserControl.stopped',
        '{{host}} stopped controlling browser tabs until Orca restarts.',
        { host }
      )
    )
  }
  const disallowed = (): void => {
    toast.success(
      translate(
        'remoteHostBrowserControl.disallowed',
        '{{host}} can no longer control browser tabs. Turn it back on in Settings > SSH.',
        { host }
      )
    )
  }
  const failed = (): void => {
    toast.error(
      translate(
        'remoteHostBrowserControl.failed',
        'Couldn’t stop {{host}}. Turn off its browser control in Settings > SSH.',
        { host }
      )
    )
  }
  toast.info(
    translate('remoteHostBrowserControl.title', '{{host}} is controlling a browser tab', { host }),
    {
      id: remoteHostBrowserControlNoticeId(notice.targetId),
      description: translate(
        'remoteHostBrowserControl.description',
        'Agents on this SSH host can open and use Orca browser tabs in its workspaces. Tabs it controls show its name. You can change this in Settings > SSH.'
      ),
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: translate('remoteHostBrowserControl.stop', 'Stop'),
        onClick: () => {
          void actions.stop(notice.targetId).then(stopped, failed)
        }
      },
      ...(notice.canDisallow
        ? {
            cancel: {
              label: translate('remoteHostBrowserControl.disallow', 'Don’t allow'),
              onClick: () => {
                void actions
                  .disallow(notice.targetId)
                  .then((turnedOff) => (turnedOff ? disallowed() : stopped()), failed)
              }
            }
          }
        : {})
    }
  )
}
