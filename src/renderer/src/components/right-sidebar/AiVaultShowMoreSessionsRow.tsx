import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { AI_VAULT_SESSION_LIMIT_STEP, type AiVaultSessionLimit } from './ai-vault-session-limit'

/** Footer row once the scan filled its History depth; steps the same setting the menu edits. */
export function AiVaultShowMoreSessionsRow({
  loaded,
  loadedSessionLimit,
  loading,
  sessionLimit,
  onSessionLimitChange
}: {
  loaded: number
  /** The depth those rows came from: still the old one while a deeper rescan runs. */
  loadedSessionLimit: AiVaultSessionLimit | null
  loading: boolean
  sessionLimit: AiVaultSessionLimit
  onSessionLimitChange: (limit: AiVaultSessionLimit) => void
}): React.JSX.Element | null {
  if (sessionLimit === 'unlimited' || loaded === 0) {
    return null
  }
  if (
    loadedSessionLimit === null ||
    loadedSessionLimit === 'unlimited' ||
    loaded < loadedSessionLimit
  ) {
    return null
  }
  return (
    <div className="border-t border-sidebar-border p-2">
      <Button
        className="w-full"
        variant="ghost"
        size="xs"
        disabled={loading}
        onClick={() => onSessionLimitChange(sessionLimit + AI_VAULT_SESSION_LIMIT_STEP)}
      >
        {loading
          ? translate('sessionSearch.panel.loadingMoreSessions', 'Loading more sessions…')
          : translate('sessionSearch.panel.showMoreSessions', 'Show more sessions')}
      </Button>
    </div>
  )
}
