import type { ClaudeSessionMoveSummary } from '../../../../../../shared/managed-account-types'
import { formatClaudeSessionMoveLine } from '../../../../../../shared/claude-session-move-line'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

/** Older hosts omit `sessionMoves`. An empty array is a host that has the list and nothing on it. */
export function ClaudeRecentMoves({
  moves
}: {
  moves: readonly ClaudeSessionMoveSummary[] | undefined
}): React.JSX.Element | null {
  if (moves === undefined) {
    return null
  }
  const title = translate('accounts.claude.sessionMover.recentMoves', 'Recent moves')
  const description = translate(
    'accounts.claude.sessionMover.recentMovesDescription',
    "The mover's last decision for each live Claude session."
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        ...translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
        ...translateSearchKeyword('accounts.claude.sessionMover.keyword.move', 'move'),
        ...translateSearchKeyword('accounts.claude.sessionMover.keyword.session', 'session'),
        ...translateSearchKeyword('accounts.claude.sessionMover.keyword.strategy', 'strategy'),
        ...translateSearchKeyword('accounts.claude.sessionMover.recentMoves', 'Recent moves'),
        ...translateSearchKeyword('accounts.claude.sessionMover.keyword.rebalance', 'rebalance')
      ]}
      className="space-y-2 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {moves.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('accounts.claude.sessionMover.recentMovesEmpty', 'No Claude session moves.')}
        </p>
      ) : (
        <ul className="space-y-1">
          {moves.map((move) => (
            <li key={move.ptyId} className="break-all font-mono text-xs text-muted-foreground">
              {formatClaudeSessionMoveLine(move)}
            </li>
          ))}
        </ul>
      )}
    </SearchableSetting>
  )
}
