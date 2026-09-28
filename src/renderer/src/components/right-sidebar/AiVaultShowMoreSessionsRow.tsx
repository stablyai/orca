import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { AI_VAULT_SESSION_LIMIT_STEP, type AiVaultSessionLimit } from './ai-vault-session-limit'

/** Footer row while a deeper scan can still add rows to this tab; steps the same setting the menu edits. */
export function AiVaultShowMoreSessionsRow({
  mayHoldMoreSessions,
  loading,
  sessionLimit,
  onSessionLimitChange
}: {
  /** From `aiVaultViewMayHoldMoreSessions`: the scan stopped at its depth and this scope is not vouched complete. */
  mayHoldMoreSessions: boolean
  loading: boolean
  sessionLimit: AiVaultSessionLimit
  onSessionLimitChange: (limit: AiVaultSessionLimit) => void
}): React.JSX.Element | null {
  if (sessionLimit === 'unlimited' || !mayHoldMoreSessions) {
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
