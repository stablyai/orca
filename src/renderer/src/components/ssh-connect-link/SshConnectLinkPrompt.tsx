import { useEffect } from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { connectSshTargetFromStatusMenu } from '@/components/status-bar/host-connections/SshTargetStatusRow'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  closeSshConnectLink,
  useSshConnectLinkStore,
  type SshConnectLinkRequest
} from './ssh-connect-link-open'

function SshConnectLinkDetails({ request }: { request: SshConnectLinkRequest }): React.JSX.Element {
  const t = useTranslate()
  const rows = [
    { label: t('sshConnectLink.host', 'Host'), value: request.alias },
    { label: t('sshConnectLink.address', 'Address'), value: request.endpoint }
  ]
  return (
    <dl className="space-y-1.5 rounded-md border border-border px-3 py-2.5">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-2">
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          <dd className="break-all font-mono text-xs">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Asks before a linked host connects: a new host key is trusted on first use, so the link alone never connects. */
export function SshConnectLinkPromptHost(): null {
  const request = useSshConnectLinkStore((state) => state.request)
  const confirm = useConfirmationDialog()
  useEffect(() => {
    if (!request) {
      return
    }
    const controller = new AbortController()
    void confirm({
      surface: 'security',
      title: translate('sshConnectLink.title', 'Connect to {{alias}}?', { alias: request.alias }),
      description: translate(
        'sshConnectLink.description',
        'A link asked Orca to connect to this SSH host. Only connect if you opened the link.'
      ),
      details: <SshConnectLinkDetails request={request} />,
      confirmLabel: translate('sshConnectLink.connect', 'Connect'),
      signal: controller.signal
    }).then((confirmed) => {
      if (controller.signal.aborted) {
        return
      }
      closeSshConnectLink(request)
      if (confirmed) {
        void connectSshTargetFromStatusMenu(request.targetId)
      }
    })
    return () => controller.abort()
  }, [confirm, request])
  return null
}
