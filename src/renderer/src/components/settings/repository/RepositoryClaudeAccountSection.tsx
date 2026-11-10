import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import type { ClaudeManagedAccountSummary } from '../../../../../shared/managed-account-types'
import type { RepoAgentAccounts } from '../../../../../shared/claude/project-claude-account-preference'
import { repoAgentAccountsEqual } from '../../../../../shared/claude/project-claude-account-preference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { useAppStore } from '../../../store'
import { claudeAccountsTargetForRepo } from '@/lib/claude-launch-account'
import { fetchProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { providerAccountMatchesView } from '../../provider-accounts/provider-account-visibility'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { searchKeywords } from '../search/settings-search-keywords'
import {
  ASK_VALUE,
  DEFAULT_VALUE,
  buildClaudeAccountOptions,
  claudeAccountPinningUnsupportedReasonInState
} from '../repository-claude-account'

type AccountVisibility = Parameters<typeof providerAccountMatchesView>[2]

async function loadVisibleClaudeAccounts(
  runtimeTarget: Parameters<typeof fetchProviderAccountsSnapshot>[0],
  visibility: AccountVisibility
): Promise<{ accounts: ClaudeManagedAccountSummary[] } | { error: string }> {
  try {
    const snapshot = await fetchProviderAccountsSnapshot(runtimeTarget)
    return {
      accounts: snapshot.claude.accounts.filter((account) =>
        providerAccountMatchesView(account, { runtime: 'host' }, visibility)
      )
    }
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.settings.RepositoryClaudeAccountSection.loadFailed',
              'Could not load Claude accounts.'
            )
    }
  }
}

async function saveClaudeAccountPreference(
  updateRepo: RepositoryClaudeAccountSectionProps['updateRepo'],
  repoId: string,
  requested: RepoAgentAccounts | null
): Promise<'saved' | 'not-enforced' | 'refused' | { error: string }> {
  try {
    const result = await Promise.resolve(updateRepo(repoId, { agentAccounts: requested }))
    if (result === false) {
      return 'refused'
    }
    const echoed = useAppStore.getState().repos.find((entry) => entry.id === repoId)?.agentAccounts
    return repoAgentAccountsEqual(requested, echoed ?? null) ? 'saved' : 'not-enforced'
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

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
  const t = useTranslate()
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

  const ownerTarget = claudeAccountsTargetForRepo(repo)
  // Why keyed on the environment id: the converter returns a fresh object each render.
  const ownerEnvironmentId = ownerTarget.kind === 'environment' ? ownerTarget.environmentId : null
  const runtimeTarget = useMemo(
    () =>
      ownerEnvironmentId
        ? { kind: 'environment' as const, environmentId: ownerEnvironmentId }
        : { kind: 'local' as const },
    [ownerEnvironmentId]
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
    const loaded = await loadVisibleClaudeAccounts(runtimeTarget, accountVisibilityOptions)
    if (generation !== loadGenerationRef.current) {
      return
    }
    if ('error' in loaded) {
      setError(loaded.error)
      setAccounts([])
    } else {
      setAccounts(loaded.accounts)
    }
    setLoading(false)
  }, [unsupportedReason, runtimeTarget, accountVisibilityOptions])

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
    const outcome = await saveClaudeAccountPreference(updateRepo, repo.id, requested)
    setSaving(false)
    if (outcome === 'refused') {
      setError(
        t(
          'auto.components.settings.RepositoryClaudeAccountSection.saveFailed',
          'Could not save the Claude account preference.'
        )
      )
    } else if (outcome === 'not-enforced') {
      setNotEnforced(true)
    } else if (typeof outcome === 'object') {
      setError(outcome.error)
    }
  }

  return (
    <SearchableSetting
      title={t('auto.components.settings.RepositoryClaudeAccountSection.title', 'Claude Account')}
      description={t(
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
          {t('auto.components.settings.RepositoryClaudeAccountSection.title', 'Claude Account')}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RepositoryClaudeAccountSection.description',
            'Choose which Claude account starts in this project.'
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <span id={selectLabelId} className="text-xs text-muted-foreground">
          {t('auto.components.settings.RepositoryClaudeAccountSection.selectLabel', 'Account')}
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
          {t(
            'auto.components.settings.RepositoryClaudeAccountSection.unsupported',
            "Per-project Claude accounts aren't supported for this project's host yet."
          )}
        </p>
      ) : null}
      {notEnforced ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RepositoryClaudeAccountSection.notEnforced',
            'Saved, but not enforced by this runtime (mixed-version host).'
          )}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SearchableSetting>
  )
}
