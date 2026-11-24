import { useEffect, useState } from 'react'
import { ExternalLink, GitPullRequestArrow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../presentation/integration-card-shell'
import { usePreflightCardStatuses } from './source-control-preflight-card-status'
import { useTranslate } from '@/i18n/use-translate'
import { tokenProviderStatusLabel } from './token-source-control-status'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { GiteaConnectDialog } from './gitea-connect-dialog'
import { GiteaConnectedServers } from './gitea-connected-servers'

export function GiteaIntegrationCard(): React.JSX.Element {
  const t = useTranslate()
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('gitea')
  const refreshGiteaStatus = useAppStore((s) => s.refreshGiteaStatus)
  const hasSavedServers = useAppStore((s) => (s.giteaStatus?.servers?.length ?? 0) > 0)
  const [connectOpen, setConnectOpen] = useState(false)
  const status = unavailable ? 'unavailable' : statuses.giteaStatus
  const configured = status === 'configured'
  useEffect(() => {
    void refreshGiteaStatus()
  }, [refreshGiteaStatus])
  const refreshAll = (): void => {
    void refreshGiteaStatus()
    refresh()
  }

  return (
    <IntegrationCardShell
      icon={<GitPullRequestArrow className="size-5" />}
      name="Gitea"
      description={
        configured
          ? statuses.giteaAccount
            ? t(
                'auto.components.settings.token.source.control.integration.cards.0b5242f8a2',
                '{{value0}} · Pull requests and commit statuses',
                { value0: statuses.giteaAccount }
              )
            : statuses.giteaBaseUrl
              ? t(
                  'auto.components.settings.token.source.control.integration.cards.0b5242f8a2',
                  '{{value0}} · Pull requests and commit statuses',
                  { value0: statuses.giteaBaseUrl }
                )
              : t(
                  'auto.components.settings.token.source.control.integration.cards.52f75876be',
                  'Pull requests and commit statuses for detected repositories'
                )
          : t(
              'auto.components.settings.token.source.control.integration.cards.05863d2599',
              'Pull requests and commit statuses via the Gitea REST API.'
            )
      }
      checking={status === 'checking'}
      actions={
        status === 'checking' || status === 'unavailable' ? null : (
          <Button
            variant={configured ? 'outline' : 'default'}
            size="sm"
            onClick={() => setConnectOpen(true)}
          >
            {hasSavedServers
              ? t('auto.components.settings.gitea.integration.card.bdcb1e773f', 'Add server')
              : t('auto.components.settings.gitea.integration.card.9ce5f12a0d', 'Connect Gitea')}
          </Button>
        )
      }
      statusTone={configured ? 'connected' : 'attention'}
      statusLabel={tokenProviderStatusLabel(
        {
          configured,
          hasAccount: Boolean(statuses.giteaAccount),
          status,
          optional: true
        },
        t
      )}
    >
      {status !== 'checking' && !configured ? (
        <IntegrationCardDetails>
          <p className="text-xs text-muted-foreground">
            {status === 'unavailable' ? (
              t(
                'auto.components.settings.token.source.control.integration.cards.0613928cb3',
                'Gitea status is not available in this runtime yet.'
              )
            ) : status === 'not-configured' ? (
              <>
                {t(
                  'auto.components.settings.token.source.control.integration.cards.fcbe0469fd',
                  'Public repositories are detected from their git remote. Set'
                )}{' '}
                <span className="font-mono text-[11px]">
                  {t(
                    'auto.components.settings.token.source.control.integration.cards.6d5c2a3005',
                    'ORCA_GITEA_TOKEN'
                  )}
                </span>{' '}
                {t(
                  'auto.components.settings.token.source.control.integration.cards.6da9dfa5de',
                  'for private repositories, and set'
                )}{' '}
                <span className="font-mono text-[11px]">
                  {t(
                    'auto.components.settings.token.source.control.integration.cards.709057ad91',
                    'ORCA_GITEA_API_BASE_URL'
                  )}
                </span>{' '}
                {t(
                  'auto.components.settings.token.source.control.integration.cards.60708f23da',
                  'only when Orca cannot derive the API URL from the remote.'
                )}
              </>
            ) : (
              t(
                'auto.components.settings.token.source.control.integration.cards.19fb419c12',
                'Gitea credentials are configured but could not authenticate. Check the token, API base URL, and repository permissions, then restart Orca if environment variables changed.'
              )
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={(event) =>
                openAppHttpLink('https://docs.gitea.com/next/development/api-usage', { event })
              }
            >
              <ExternalLink className="size-3.5 mr-1.5" />
              {t(
                'auto.components.settings.token.source.control.integration.cards.1a9475dace',
                'Learn more'
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={refresh}>
              {t(
                'auto.components.settings.token.source.control.integration.cards.793a06e899',
                'Re-check'
              )}
            </Button>
          </div>
        </IntegrationCardDetails>
      ) : null}
      <GiteaConnectedServers onChanged={refreshAll} />
      <GiteaConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={refreshAll}
      />
    </IntegrationCardShell>
  )
}
