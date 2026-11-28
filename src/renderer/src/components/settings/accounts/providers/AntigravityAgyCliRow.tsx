import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import { useAgentCliUpdate } from '@/components/agent-cli-update/use-agent-cli-update'
import { AgentCliUpdateButton } from '@/components/agent-cli-update/AgentCliUpdateButton'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { Button } from '../../../ui/button'

export const AGY_INSTALL_DOCS_URL = 'https://antigravity.google/docs/getting-started?tab=cli'

/** agy on this host: Google's installer when it's missing, its Update when a newer agy is out.
 *  Renders nothing while agy is found and current. */
export function AntigravityAgyCliRow({
  owner,
  installed,
  checking,
  onCheckAgain
}: {
  owner: RuntimeClientTarget
  /** Whether the host's agent list has agy; null until it is read. */
  installed: boolean | null
  checking: boolean
  onCheckAgain: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { update } = useAgentCliUpdate(owner, 'antigravity')
  const checkAgentCliUpdates = useAppStore((s) => s.checkAgentCliUpdates)
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  // Opening Settings on a host counts as using it; the host answers from its cache.
  useEffect(() => {
    if (installed) {
      void checkAgentCliUpdates(
        environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
      )
    }
  }, [checkAgentCliUpdates, environmentId, installed])
  const detectionTarget: AgentDetectionTarget = environmentId
    ? { kind: 'runtime', environmentId }
    : { kind: 'local' }
  if (installed === null || (installed && !update?.runnable)) {
    return null
  }
  return (
    <div data-settings-row="" className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('accounts.antigravity.agyCli', 'agy CLI')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {update ? (
            t('accounts.antigravity.agyUpdateAvailable', 'v{{installed}} · v{{latest}} available', {
              installed: update.installedVersion,
              latest: update.latestVersion
            })
          ) : (
            <>
              {t('accounts.antigravity.agyNotInstalled', 'Not installed on this host.')}{' '}
              <a
                className="text-foreground underline underline-offset-2"
                href={AGY_INSTALL_DOCS_URL}
                target="_blank"
                onClick={openAppHttpLinkFromAnchor}
                rel="noopener noreferrer"
              >
                {t('accounts.antigravity.agyInstallLink', "Install it with Google's installer")}
              </a>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {update ? (
          <AgentCliUpdateButton detectionTarget={detectionTarget} agent="antigravity" />
        ) : (
          <Button variant="outline" size="xs" disabled={checking} onClick={onCheckAgain}>
            {checking ? <Loader2 className="animate-spin" /> : null}
            {t('components.native-chat.install.cliRecheck', 'Check again')}
          </Button>
        )}
      </div>
    </div>
  )
}
