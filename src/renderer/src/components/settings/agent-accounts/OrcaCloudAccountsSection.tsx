// Wires S0 to main: the setup steps run there, and this only reads states and sends intents.
import { useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { useWorktreeCreationClock } from '@/components/worktree-creation/worktree-creation-clock'
import { orcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import {
  applyOrcaCloudAgentCredentials,
  applyOrcaCloudAgentSources,
  reloadOrcaCloudAgentAccounts,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { ORCA_CLOUD_ACCOUNT_AGENTS } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { OrcaCloudAccountsView, type OrcaCloudAccountsActions } from './OrcaCloudAccounts'

export function OrcaCloudAccountsSection({
  hideHeader = false
}: {
  hideHeader?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { load, setups, keyKinds } = useOrcaCloudAgentAccounts()
  const running = ORCA_CLOUD_ACCOUNT_AGENTS.some((agent) =>
    ['browser', 'preparing', 'device'].includes(setups[agent].phase)
  )
  const now = useWorktreeCreationClock(running)
  const rows = useMemo(
    () =>
      load.kind === 'ready'
        ? {
            claude: orcaCloudAccountRow('claude', load.status, setups.claude, keyKinds.claude),
            codex: orcaCloudAccountRow('codex', load.status, setups.codex, keyKinds.codex)
          }
        : null,
    [load, setups, keyKinds]
  )
  const actions = useMemo<OrcaCloudAccountsActions>(() => {
    const api = window.api.orcaCloudAgents
    return {
      start: (agent) => void api?.start({ agent }),
      cancel: (agent) => void api?.cancel({ agent }),
      reopen: (agent) => void api?.reopen({ agent }),
      usePaste: () => void api?.usePaste(),
      pasteToken: async (token) => {
        if (!api) {
          return 'not_configured'
        }
        const result = await api.pasteClaudeToken({ token }).catch(() => null)
        return result === null ? 'unknown' : result.ok ? null : result.error
      },
      remove: async (agent) => {
        if (!api) {
          return 'not_configured'
        }
        const result = await api.remove({ agent })
        if (result.ok) {
          applyOrcaCloudAgentCredentials(result.value)
          return null
        }
        // Already gone on the server: show what's there now.
        if (result.error === 'not_found') {
          void reloadOrcaCloudAgentAccounts()
          return null
        }
        return result.error
      },
      setSource: async (agent, source) => {
        if (!api) {
          return 'not_configured'
        }
        const result = await api.setDefaultSource({ agent, source })
        if (result.ok) {
          applyOrcaCloudAgentSources(result.value)
          return null
        }
        return result.error
      },
      copyCode: (code) => {
        void window.api.ui
          .writeClipboardText(code)
          .then(() => toast.success(t('orcaCloudAccounts.codeCopied', 'Code copied')))
          .catch(() => {})
      },
      retryLoad: () => void reloadOrcaCloudAgentAccounts(),
      signIn: () =>
        void useAppStore
          .getState()
          .connectCurrentOrcaProfile()
          .then(() => reloadOrcaCloudAgentAccounts())
    }
  }, [t])
  return (
    <OrcaCloudAccountsView
      load={load}
      rows={rows}
      actions={actions}
      now={now}
      hideHeader={hideHeader}
    />
  )
}
