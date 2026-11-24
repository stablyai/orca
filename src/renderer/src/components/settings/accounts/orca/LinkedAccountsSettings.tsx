// Linked accounts for a host's Orca account: this computer's, or a paired server's (`hostName`).
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { BOT_CONNECTORS } from '@/components/bots/bot-connectors'
import { botGitHubErrorMessage } from '@/components/bots/github/bot-github-copy'
import { botLinearErrorMessage } from '@/components/bots/linear/bot-linear-copy'
import { connectorLinksCalls } from '@/lib/bot-connector-host-calls'
import { refreshBotGitHub } from '@/lib/bot-github-state'
import { refreshBotLinear } from '@/lib/bot-linear-state'
import {
  cancelConnectorConnect,
  startConnectorConnect,
  useConnectorConnect
} from '@/lib/connector-connect-state'
import { refreshConnectorLinks, useConnectorLinks } from '@/lib/connector-links-state'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  CONNECTOR_CONNECT_SOURCES,
  type ConnectorConnectSource
} from '../../../../../../shared/connectors/connector-cloud-contract'
import type {
  ConnectorLink,
  ConnectorLinkSource
} from '../../../../../../shared/connectors/connector-links-contract'
import { LinkedAccountsList, type LinkedAccountsTrip } from './LinkedAccountsList'

function linksErrorMessage(code: string, hostName: string | null): string {
  switch (code) {
    case 'signed_out':
      return hostName
        ? translate('settings.linkedAccounts.signedOutOnHost', 'Sign {{host}} in to Orca again.', {
            host: hostName
          })
        : translate('settings.linkedAccounts.signedOut', 'Sign in to Orca again.')
    case 'cloud_unreachable':
      return translate(
        'settings.linkedAccounts.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

const isConnectSource = (source: ConnectorLinkSource): source is ConnectorConnectSource =>
  CONNECTOR_CONNECT_SOURCES.some((connectSource) => connectSource === source)

/** A link or unlink changes what the source's own settings show too. */
function refreshSource(hostId: ExecutionHostId, source: ConnectorLinkSource): Promise<unknown> {
  return source === 'linear'
    ? refreshBotLinear(hostId)
    : source === 'github'
      ? refreshBotGitHub(hostId)
      : Promise.resolve()
}

function useTrip(
  hostId: ExecutionHostId,
  source: ConnectorConnectSource,
  hostName: string | null
): LinkedAccountsTrip {
  const view = useConnectorConnect(hostId, source)
  // A paired web window can't open the provider's page where the host's return reaches.
  if (isPairedWebClientWindow()) {
    return null
  }
  const error =
    view.status !== 'failed'
      ? null
      : source === 'github'
        ? botGitHubErrorMessage(view.error, hostName)
        : botLinearErrorMessage(view.error, hostName)
  return { waiting: view.status === 'waiting', error }
}

export function LinkedAccountsSettings({
  hostId,
  hostName
}: {
  hostId: ExecutionHostId
  hostName: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const view = useConnectorLinks(hostId)
  const trips = {
    slack: null,
    github: useTrip(hostId, 'github', hostName),
    linear: useTrip(hostId, 'linear', hostName)
  } satisfies Record<ConnectorLinkSource, LinkedAccountsTrip>

  if (view.status === 'off' || view.status === 'loading') {
    return null
  }
  if (view.status === 'failed') {
    return (
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {linksErrorMessage(view.error, hostName)}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refreshConnectorLinks(hostId)}>
          {t('settings.linkedAccounts.retry', 'Try again')}
        </Button>
      </div>
    )
  }

  const link = (source: ConnectorLinkSource): void => {
    if (isConnectSource(source)) {
      const another = view.links.some((entry) => entry.source === source)
      void startConnectorConnect(hostId, source, { switchAccount: another })
    }
  }
  const cancel = (source: ConnectorLinkSource): void => {
    if (isConnectSource(source)) {
      cancelConnectorConnect(hostId, source)
    }
  }
  const unlink = async (entry: ConnectorLink): Promise<void> => {
    const service =
      BOT_CONNECTORS.find((connector) => connector.id === entry.source)?.label ?? entry.source
    const confirmed = await confirm({
      title: t('settings.linkedAccounts.unlinkTitle', 'Unlink {{name}} on {{service}}?', {
        name: entry.workspaceName || entry.name || entry.userId,
        service
      }),
      description: entry.workspaceName
        ? t(
            'settings.linkedAccounts.unlinkNoteWorkspace',
            'Bots shared with you won’t know it’s you in that workspace.'
          )
        : t(
            'settings.linkedAccounts.unlinkNote',
            'Bots shared with you won’t know it’s you on {{service}}.',
            { service }
          ),
      confirmLabel: t('settings.linkedAccounts.unlink', 'Unlink'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const result = await connectorLinksCalls(hostId).unlink({
      source: entry.source,
      workspaceId: entry.workspaceId,
      userId: entry.userId
    })
    // Already gone reads the same as unlinked: the list is read again either way.
    if (!result.ok && result.error !== 'not_linked') {
      toast.error(linksErrorMessage(result.error, hostName))
    }
    await Promise.all([refreshConnectorLinks(hostId), refreshSource(hostId, entry.source)])
  }

  return (
    <LinkedAccountsList
      links={view.links}
      trips={trips}
      onLink={link}
      onCancel={cancel}
      onUnlink={(entry) => void unlink(entry)}
    />
  )
}
