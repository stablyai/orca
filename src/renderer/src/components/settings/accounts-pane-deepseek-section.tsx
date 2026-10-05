import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { getDeepSeekAccountScope } from '@/runtime/deepseek-account-scope'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { DeepSeekAccountsSection } from './DeepSeekAccountsSection'
import { getAccountsDeepSeekSearchEntries } from './accounts-deepseek-search'
import { matchesSettingsSearch } from './settings-search'

export function renderDeepSeekAccountsSection(
  model: AccountsPaneSectionModel,
  scope: ReturnType<typeof getDeepSeekAccountScope>,
  executionHostId: ExecutionHostId | null,
  label: string
): React.JSX.Element | null {
  return matchesSettingsSearch(model.searchQuery, getAccountsDeepSeekSearchEntries()) ? (
    <DeepSeekAccountsSection
      key={`deepseek:${scope.environmentId ?? 'local'}:${model.localAccountRuntime.runtime}:${executionHostId ?? 'local'}`}
      environmentId={scope.environmentId}
      unsupportedRuntime={scope.unsupported}
      scopeLabel={label}
    />
  ) : null
}
