import { useState } from 'react'
import { CheckCircle2, LoaderCircle, Paperclip, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { PAPERCLIP_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

export function PaperclipIntegrationCard(): React.JSX.Element {
  const status = useAppStore((state) => state.paperclipStatus)
  const checked = useAppStore((state) => state.paperclipStatusChecked)
  const connect = useAppStore((state) => state.connectLocalPaperclip)
  const disconnect = useAppStore((state) => state.disconnectPaperclip)
  const testConnection = useAppStore((state) => state.testPaperclipConnection)
  const [origin, setOrigin] = useState('http://127.0.0.1:3100')
  const [companyId, setCompanyId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const connection = status.connection

  const handleConnect = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    const result = await connect({ origin, companyId, projectId })
    setBusy(false)
    setMessage(result.ok ? 'Connected.' : result.error)
  }

  const handleTest = async (): Promise<void> => {
    setBusy(true)
    const result = await testConnection()
    setBusy(false)
    setMessage(result.ok ? 'Connection verified.' : result.error)
  }

  return (
    <IntegrationCardShell
      settingsSectionId={PAPERCLIP_INTEGRATION_SECTION_ID}
      icon={<Paperclip className="size-5" />}
      name="Paperclip"
      description={
        connection
          ? `${connection.companyName} · ${connection.projectName}`
          : translate(
              'auto.components.settings.paperclip.description',
              'Browse Paperclip issues and start linked Orca workspaces.'
            )
      }
      checking={!checked}
      statusTone={connection ? 'connected' : 'attention'}
      statusLabel={connection ? 'Connected' : 'Not connected'}
    >
      <IntegrationCardDetails>
        {connection ? (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              <p>{connection.origin}</p>
              <p>
                {connection.companyName} · {connection.projectName}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleTest()}>
                {busy ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : null}
                {translate('auto.components.settings.paperclip.test', 'Test')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
                <Unlink className="mr-1.5 size-3.5" />
                {translate('auto.components.settings.paperclip.disconnect', 'Disconnect')}
              </Button>
            </div>
          </div>
        ) : checked ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.paperclip.localOnly',
                'Initial support is limited to Paperclip’s local-trusted loopback server. Authenticated and remote-only servers stay disabled so credentials never cross renderer or runtime boundaries.'
              )}
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input
                aria-label={translate(
                  'auto.components.settings.paperclip.origin',
                  'Paperclip origin'
                )}
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              />
              <Input
                aria-label={translate(
                  'auto.components.settings.paperclip.companyId',
                  'Paperclip company ID'
                )}
                placeholder={translate(
                  'auto.components.settings.paperclip.companyIdPlaceholder',
                  'Company ID'
                )}
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              />
              <Input
                aria-label={translate(
                  'auto.components.settings.paperclip.projectId',
                  'Paperclip project ID'
                )}
                placeholder={translate(
                  'auto.components.settings.paperclip.projectIdPlaceholder',
                  'Project ID'
                )}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={busy || !companyId.trim() || !projectId.trim()}
              onClick={() => void handleConnect()}
            >
              {busy ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : null}
              {translate('auto.components.settings.paperclip.connect', 'Connect local Paperclip')}
            </Button>
          </div>
        ) : null}
        {message ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {message.endsWith('verified.') || message === 'Connected.' ? (
              <CheckCircle2 className="size-3.5 text-status-success" />
            ) : null}
            {message}
          </p>
        ) : null}
      </IntegrationCardDetails>
    </IntegrationCardShell>
  )
}
