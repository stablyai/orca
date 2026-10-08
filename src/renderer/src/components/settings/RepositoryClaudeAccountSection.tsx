import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import type { RepoAgentAccounts } from '../../../../shared/claude/project-claude-account-preference'
import { repoAgentAccountsEqual } from '../../../../shared/claude/project-claude-account-preference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '../../store'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { providerAccountMatchesView } from './provider-account-visibility'
import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'
import {
  ASK_VALUE,
  DEFAULT_VALUE,
  buildClaudeAccountOptions,
  claudeAccountPinningUnsupportedReasonInState
} from './repository-claude-account'

type RepositoryClaudeAccountSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: { agentAccounts?: RepoAgentAccounts | null }) => unknown
  forceVisible?: boolean
}

export function RepositoryClaudeAccountSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryClaudeAccountSectionProps): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const [accounts, setAccounts] = useState<ClaudeManagedAccountSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notEnforced, setNotEnforced] = useState(false)
  const loadGenerationRef = useRef(0)
  const selectLabelId = useId()

  const unsupportedReason = useAppStore((state) =>
    claudeAccountPinningUnsupportedReasonInState(state, repo)
  )

  // Why: getRepoOwnerRoutedSettings returns a fresh object each render, and the target
  // depends on nothing else — key the memo on the id so it stays stable.
  const activeRuntimeEnvironmentId =
    getRepoOwnerRoutedSettings(settings, repo)?.activeRuntimeEnvironmentId ?? null
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )
  const accountVisibilityOptions = useMemo(
    () => ({ remoteOwner: runtimeTarget.kind === 'environment', ownerPlatform: null }),
    [runtimeTarget]
  )

  const loadAccounts = useCallback(async () => {
    if (unsupportedReason) {
      return
    }
    const generation = ++loadGenerationRef.current
    setLoading(true)
    setError(null)
    try {
      const snapshot = await fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId })
      if (generation !== loadGenerationRef.current) {
        return
      }
      setAccounts(
        snapshot.claude.accounts.filter((account) =>
          providerAccountMatchesView(account, { runtime: 'host' }, accountVisibilityOptions)
        )
      )
    } catch (err) {
      if (generation !== loadGenerationRef.current) {
        return
      }
      setError(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.RepositoryClaudeAccountSection.loadFailed',
              'Could not load Claude accounts.'
            )
      )
      setAccounts([])
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false)
      }
    }
  }, [unsupportedReason, activeRuntimeEnvironmentId, accountVisibilityOptions])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  const saved = repo.agentAccounts?.claude
  const options = buildClaudeAccountOptions({ accounts, saved })
  const selectedValue = !saved ? DEFAULT_VALUE : saved.mode === 'ask' ? ASK_VALUE : saved.accountId

  const applyPreference = async (requested: RepoAgentAccounts | null): Promise<void> => {
    if (saving) {
      return
    }
    setSaving(true)
    setError(null)
    setNotEnforced(false)
    try {
      const result = await Promise.resolve(updateRepo(repo.id, { agentAccounts: requested }))
      if (result === false) {
        setError(
          translate(
            'auto.components.settings.RepositoryClaudeAccountSection.saveFailed',
            'Could not save the Claude account preference.'
          )
        )
        return
      }
      const echoed = useAppStore
        .getState()
        .repos.find((entry) => entry.id === repo.id)?.agentAccounts
      if (!repoAgentAccountsEqual(requested, echoed ?? null)) {
        setNotEnforced(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.RepositoryClaudeAccountSection.title',
        'Claude Account'
      )}
      description={translate(
        'auto.components.settings.RepositoryClaudeAccountSection.description',
        'Choose which Claude account starts in this project.'
      )}
      keywords={searchKeywords([
        repo.displayName,
        'claude',
        'claude account',
        'account',
        'accounts',
        {
          key: 'auto.components.settings.repository.search.claudeAccountKeyword',
          fallback: 'claude account'
        },
        {
          key: 'auto.components.settings.repository.search.claudeAccountsKeyword',
          fallback: 'claude accounts'
        }
      ])}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryClaudeAccountSection.title',
            'Claude Account'
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryClaudeAccountSection.description',
            'Choose which Claude account starts in this project.'
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <span id={selectLabelId} className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryClaudeAccountSection.selectLabel',
            'Account'
          )}
        </span>
        <Select
          value={selectedValue}
          // Why: an unsupported project still gets to clear a preference saved before it became one.
          disabled={loading || saving || (Boolean(unsupportedReason) && !saved)}
          onValueChange={(value) => {
            if (value === selectedValue) {
              return
            }
            if (value === DEFAULT_VALUE) {
              void applyPreference(null)
              return
            }
            if (value === ASK_VALUE) {
              void applyPreference({ claude: { mode: 'ask' } })
              return
            }
            const account = accounts.find((entry) => entry.id === value)
            if (!account) {
              return
            }
            void applyPreference({ claude: { mode: 'account', accountId: value } })
          }}
        >
          <SelectTrigger size="sm" className="w-full" aria-labelledby={selectLabelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={
                  option.disabled || (Boolean(unsupportedReason) && option.value !== DEFAULT_VALUE)
                }
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {unsupportedReason ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryClaudeAccountSection.unsupported',
            "Per-project Claude accounts aren't supported for this project's host yet."
          )}
        </p>
      ) : null}
      {notEnforced ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryClaudeAccountSection.notEnforced',
            'Saved, but not enforced by this runtime (mixed-version host).'
          )}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SearchableSetting>
  )
}
