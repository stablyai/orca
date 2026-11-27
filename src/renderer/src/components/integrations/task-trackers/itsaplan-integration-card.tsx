import { useEffect, useState } from 'react'
import { Unlink } from 'lucide-react'
import { ItsaplanConnectDialog } from '@/components/itsaplan-connect-dialog'
import { ItsaplanIcon } from '@/components/icons/ItsaplanIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { UnsealedCredentialNotice } from '../../provider-accounts/UnsealedCredentialNotice'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../presentation/integration-card-shell'
import { useIntegrationSubordinateRowClass } from '../presentation/integration-card-presentation'
import { ITSAPLAN_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { useTranslate } from '@/i18n/use-translate'

export function ItsaplanIntegrationCard(): React.JSX.Element {
  const t = useTranslate()
  const itsaplanStatus = useAppStore((s) => s.itsaplanStatus)
  const refreshItsaplanStatus = useAppStore((s) => s.refreshItsaplanStatus)
  const disconnectItsaplan = useAppStore((s) => s.disconnectItsaplan)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')

  const checking = itsaplanStatus === null && refreshError === null
  const connected = itsaplanStatus?.connected === true

  useEffect(() => {
    if (itsaplanStatus === null) {
      refreshItsaplanStatus().catch((caught: unknown) => {
        setRefreshError(caught instanceof Error ? caught.message : String(caught))
      })
    }
  }, [itsaplanStatus, refreshItsaplanStatus])

  return (
    <IntegrationCardShell
      settingsSectionId={ITSAPLAN_INTEGRATION_SECTION_ID}
      icon={<ItsaplanIcon className="size-5" />}
      name={t('components.itsaplanIntegrationCard.name', "It's a Plan")}
      description={
        connected
          ? t('components.itsaplanIntegrationCard.connectedDescription', '1 instance connected')
          : checking
            ? t(
                'components.itsaplanIntegrationCard.checking',
                "Checking It's a Plan access before showing setup actions."
              )
            : t(
                'components.itsaplanIntegrationCard.description',
                "Browse and start work from your self-hosted It's a Plan issues."
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? t('components.itsaplanIntegrationCard.statusConnected', 'Connected')
          : t('components.itsaplanIntegrationCard.statusNotConnected', 'Not connected')
      }
      actions={
        !checking && !connected ? (
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            {t('components.itsaplanIntegrationCard.connect', "Connect It's a Plan")}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <UnsealedCredentialNotice
          protection={itsaplanStatus?.credentialProtection ?? null}
          credentialName={t(
            'components.itsaplanIntegrationCard.credentialName',
            "Your It's a Plan API key"
          )}
        />
        {refreshError ? (
          <p role="alert" className="text-xs text-destructive">
            {refreshError}
          </p>
        ) : null}
        {itsaplanStatus?.credentialError ? (
          <p role="alert" className="text-xs text-destructive">
            {itsaplanStatus.credentialError}
          </p>
        ) : null}
        {connected && itsaplanStatus?.instance ? (
          <div className={subordinateRowClass}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {itsaplanStatus.viewer?.name ?? itsaplanStatus.instance.appUrl}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {itsaplanStatus.instance.appUrl}
                {itsaplanStatus.viewer?.email ? ` · ${itsaplanStatus.viewer.email}` : ''}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void disconnectItsaplan()}>
              <Unlink className="size-3.5 mr-1.5" />
              {t('components.itsaplanIntegrationCard.disconnect', 'Disconnect')}
            </Button>
          </div>
        ) : !checking && !connected ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'components.itsaplanIntegrationCard.credentialCopy',
              "Connect a self-hosted It's a Plan with an API key. The key is stored locally and encrypted when local storage supports it."
            )}
          </p>
        ) : null}
      </IntegrationCardDetails>

      <ItsaplanConnectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </IntegrationCardShell>
  )
}
