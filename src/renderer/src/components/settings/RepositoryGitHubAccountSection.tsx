import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { GhAccountBinding } from '../../../../shared/github/account-binding'
import type { Repo } from '../../../../shared/repo-types'
import type { GhAccountBindingInventory } from '../../../../shared/github/auth-types'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '../../store'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'
import {
  isGhAccountBindingEnforced,
  listRepositoryGhBindableAccounts,
  validateRepositoryGhAccountBinding
} from './repository-github-account'

type RepositoryGitHubAccountSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: { ghAccount?: GhAccountBinding | null }) => unknown
  forceVisible?: boolean
}

function accountKey(host: string, user: string): string {
  return `${host.toLowerCase()}\0${user.toLowerCase()}`
}

// Why: Radix Select rejects an empty item value, so "inherit the ambient login" needs a sentinel.
const AMBIENT_VALUE = '__ambient_gh_login__'

export function RepositoryGitHubAccountSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryGitHubAccountSectionProps): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const [inventory, setInventory] = useState<GhAccountBindingInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notEnforced, setNotEnforced] = useState(false)
  const loadGenerationRef = useRef(0)
  const selectLabelId = useId()

  // Why: getRepoOwnerRoutedSettings returns a fresh object each render, and the target
  // depends on nothing else — key the memo on the id so it stays stable.
  const activeRuntimeEnvironmentId =
    getRepoOwnerRoutedSettings(settings, repo)?.activeRuntimeEnvironmentId ?? null
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )

  const loadInventory = useCallback(
    async (refreshCapability = false) => {
      const generation = ++loadGenerationRef.current
      setLoading(true)
      setError(null)
      try {
        const next = await listRepositoryGhBindableAccounts(runtimeTarget, repo, {
          refreshCapability
        })
        if (generation !== loadGenerationRef.current) {
          return
        }
        setInventory(next)
      } catch (err) {
        if (generation !== loadGenerationRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : String(err))
        setInventory(null)
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false)
        }
      }
    },
    [repo, runtimeTarget]
  )

  useEffect(() => {
    void loadInventory()
  }, [loadInventory])

  const capabilityUnsupported = inventory?.capability === 'unsupported'
  const capabilityUnknown = inventory?.capability === 'unknown'
  const capabilityBlocksBinding = capabilityUnsupported || capabilityUnknown
  const selectedKey = repo.ghAccount ? accountKey(repo.ghAccount.host, repo.ghAccount.user) : ''
  const inventoryAccounts = inventory?.accounts ?? []
  const selectedInInventory = Boolean(
    repo.ghAccount &&
    inventoryAccounts.some((entry) => accountKey(entry.host, entry.user) === selectedKey)
  )

  const applyBinding = async (requested: GhAccountBinding | null) => {
    if (saving) {
      return
    }
    setSaving(true)
    setError(null)
    setNotEnforced(false)
    try {
      let resolved = requested
      if (requested) {
        const validation = await validateRepositoryGhAccountBinding(runtimeTarget, repo, requested)
        if (!validation.ok) {
          setError(
            validation.error === 'gh_multi_account_unsupported'
              ? translate(
                  'auto.components.settings.RepositoryGitHubAccountSection.unsupported',
                  'This runtime’s GitHub CLI is too old for account binding (needs gh ≥ 2.40).'
                )
              : validation.error === 'gh_multi_account_capability_unknown'
                ? translate(
                    'auto.components.settings.RepositoryGitHubAccountSection.capabilityUnknown',
                    'Could not determine whether this runtime’s GitHub CLI supports account binding. Retry.'
                  )
                : validation.error === 'gh_bound_account_not_keyring'
                  ? translate(
                      'auto.components.settings.RepositoryGitHubAccountSection.envToken',
                      'Environment-token accounts cannot be bound. Use a keyring login.'
                    )
                  : validation.error === 'invalid_binding'
                    ? translate(
                        'auto.components.settings.RepositoryGitHubAccountSection.invalidBinding',
                        'That GitHub account binding is invalid.'
                      )
                    : translate(
                        'auto.components.settings.RepositoryGitHubAccountSection.unavailable',
                        'That GitHub account is unavailable on this runtime.'
                      )
          )
          return
        }
        resolved = validation.binding
      }
      const result = await Promise.resolve(updateRepo(repo.id, { ghAccount: resolved }))
      if (result === false) {
        setError(
          translate(
            'auto.components.settings.RepositoryGitHubAccountSection.saveFailed',
            'Could not save the GitHub account binding.'
          )
        )
        return
      }
      const echoed = useAppStore.getState().repos.find((entry) => entry.id === repo.id)?.ghAccount
      if (!isGhAccountBindingEnforced(resolved, echoed)) {
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
        'auto.components.settings.RepositoryGitHubAccountSection.title',
        'GitHub Account'
      )}
      description={translate(
        'auto.components.settings.RepositoryGitHubAccountSection.description',
        'Use a specific gh login for this project’s GitHub issue and pull request calls.'
      )}
      keywords={searchKeywords([
        repo.displayName,
        'github',
        'gh account',
        'github account',
        'login',
        'token',
        {
          key: 'auto.components.settings.repository.search.githubAccountKeyword',
          fallback: 'github account'
        }
      ])}
      className="space-y-3"
      forceVisible={forceVisible}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold">
            {translate(
              'auto.components.settings.RepositoryGitHubAccountSection.title',
              'GitHub Account'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryGitHubAccountSection.longDescription',
              'Orca injects a short-lived token from the selected keyring login into each gh call for this project. Project View stays on the ambient login.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadInventory(true)}
          disabled={loading || saving}
          className="shrink-0"
        >
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {translate('auto.components.settings.RepositoryGitHubAccountSection.retry', 'Retry')}
        </Button>
      </div>

      <div className="space-y-1.5">
        <span id={selectLabelId} className="block text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryGitHubAccountSection.selectLabel',
            'Account'
          )}
        </span>
        <Select
          value={repo.ghAccount ? selectedKey : AMBIENT_VALUE}
          disabled={loading || saving}
          onValueChange={(value) => {
            if (value === AMBIENT_VALUE) {
              if (repo.ghAccount) {
                void applyBinding(null)
              }
              return
            }
            if (repo.ghAccount && selectedKey === value) {
              return
            }
            const account = inventoryAccounts.find(
              (entry) => accountKey(entry.host, entry.user) === value
            )
            if (!account || account.source !== 'keyring') {
              return
            }
            void applyBinding({ host: account.host, user: account.user })
          }}
        >
          <SelectTrigger size="sm" className="w-full" aria-labelledby={selectLabelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AMBIENT_VALUE}>
              {translate(
                'auto.components.settings.RepositoryGitHubAccountSection.ambient',
                'Default (ambient gh login)'
              )}
            </SelectItem>
            {repo.ghAccount && !selectedInInventory ? (
              // Why: keep the bound account's key as the item value so the trigger shows it; disabled so it cannot be re-picked.
              <SelectItem value={selectedKey} disabled>
                {translate(
                  'auto.components.settings.RepositoryGitHubAccountSection.unavailableOption',
                  '{{user}} @ {{host}} (unavailable)',
                  { user: repo.ghAccount.user, host: repo.ghAccount.host }
                )}
              </SelectItem>
            ) : null}
            {inventoryAccounts.map((account) => {
              const key = accountKey(account.host, account.user)
              const disabled = account.source !== 'keyring' || capabilityBlocksBinding
              const label =
                account.source === 'keyring'
                  ? `${account.user} @ ${account.host}`
                  : `${account.user} @ ${account.host} (${account.envToken ?? 'env'})`
              return (
                <SelectItem key={key} value={key} disabled={disabled}>
                  {label}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>

      {capabilityUnsupported ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryGitHubAccountSection.capabilityBlocked',
            'Binding is unavailable until this runtime’s GitHub CLI supports `gh auth token --user` (gh ≥ 2.40).'
          )}
        </p>
      ) : null}
      {capabilityUnknown ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryGitHubAccountSection.capabilityUnknownHint',
            'Could not determine GitHub CLI account-binding support on this runtime. Clear the binding or retry.'
          )}
        </p>
      ) : null}
      {notEnforced ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryGitHubAccountSection.notEnforced',
            'Saved, but not enforced by this runtime (mixed-version host).'
          )}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SearchableSetting>
  )
}
