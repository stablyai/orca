import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, SquareKanban, Unlink } from 'lucide-react'

import { KanbanConnectDialog } from '@/components/kanban-connect-dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { KANBAN_SERVER_URL } from '../../../../shared/kanban-types'
import type { KanbanConnectionStatus } from '../../../../shared/kanban-types'
import { translate } from '@/i18n/i18n'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { KANBAN_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'

export function KanbanIntegrationCard(): React.JSX.Element {
  const [status, setStatus] = useState<KanbanConnectionStatus>({
    connected: false,
    reason: 'missing'
  })
  const [statusChecked, setStatusChecked] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const mountedRef = useMountedRef()

  const refreshStatus = useCallback((): void => {
    void window.api.kanban
      .status()
      .then((next) => {
        if (mountedRef.current) {
          setStatus(next)
          setStatusChecked(true)
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setStatusChecked(true)
        }
      })
  }, [mountedRef])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const connected = status.connected
  const viewer = status.connected ? status.viewer : null

  const handleDisconnect = async (): Promise<void> => {
    await window.api.kanban.disconnect()
    if (mountedRef.current) {
      setStatus({ connected: false, reason: 'missing' })
      setStatusChecked(true)
    }
  }

  return (
    <IntegrationCardShell
      settingsSectionId={KANBAN_INTEGRATION_SECTION_ID}
      icon={<SquareKanban className="size-5" />}
      name="Kanban"
      description={
        connected
          ? translate(
              'auto.components.settings.kanban.integration.card.connectedDescription',
              'Browse and start work from your tasks on {{value0}}.',
              { value0: KANBAN_SERVER_URL }
            )
          : statusChecked
            ? translate(
                'auto.components.settings.kanban.integration.card.notConnectedDescription',
                'Connect a personal token to browse tasks from {{value0}}.',
                { value0: KANBAN_SERVER_URL }
              )
            : translate(
                'auto.components.settings.kanban.integration.card.checkingDescription',
                'Checking Kanban access before showing setup actions.'
              )
      }
      checking={!statusChecked}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate(
              'auto.components.settings.kanban.integration.card.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.kanban.integration.card.statusNotConnected',
              'Not connected'
            )
      }
      actions={
        statusChecked ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? translate(
                  'auto.components.settings.kanban.integration.card.updateToken',
                  'Update token'
                )
              : translate(
                  'auto.components.settings.kanban.integration.card.connect',
                  'Connect Kanban'
                )}
          </Button>
        ) : (
          <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
        )
      }
    >
      <IntegrationCardDetails>
        {connected && viewer ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{viewer.name}</p>
                <p className="truncate text-xs text-muted-foreground">{KANBAN_SERVER_URL}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDisconnect()}
                aria-label={translate(
                  'auto.components.settings.kanban.integration.card.disconnectLabel',
                  'Disconnect Kanban'
                )}
                className="shrink-0"
              >
                <Unlink className="size-3.5" />
                {translate(
                  'auto.components.settings.kanban.integration.card.disconnect',
                  'Disconnect'
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              {translate(
                'auto.components.settings.kanban.integration.card.tokenNote',
                'One personal token is stored by the active runtime for {{value0}}.',
                { value0: KANBAN_SERVER_URL }
              )}
            </p>
          </div>
        ) : statusChecked ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.kanban.integration.card.credentialCopy',
                'Add a personal token from your Kanban profile. The token is never shown in Orca.'
              )}
            </p>
            <Button variant="ghost" size="sm" onClick={refreshStatus}>
              {translate('auto.components.settings.kanban.integration.card.recheck', 'Re-check')}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <KanbanConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={refreshStatus}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
