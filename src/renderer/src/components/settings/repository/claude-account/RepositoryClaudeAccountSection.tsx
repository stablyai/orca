import { useEffect, useId, useState } from 'react'
import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { ClaudeManagedAccountSummary } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import { searchKeywords } from '../../search/settings-search-keywords'

type RepositoryClaudeAccountSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: { claudeAccount?: ClaudeAccountBinding | null }) => unknown
  forceVisible?: boolean
}

// Radix forbids empty item values.
const SELECTION_VALUE = '__follow_selection__'
const PICK_FOLDER_VALUE = '__pick_folder__'
const FOLDER_PREFIX = 'folder:'
const ACCOUNT_PREFIX = 'account:'

function bindingValue(binding: ClaudeAccountBinding | undefined): string {
  if (!binding) {
    return SELECTION_VALUE
  }
  return binding.kind === 'managed'
    ? `${ACCOUNT_PREFIX}${binding.accountId}`
    : `${FOLDER_PREFIX}${binding.configDir}`
}

export function RepositoryClaudeAccountSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryClaudeAccountSectionProps): React.JSX.Element | null {
  const t = useTranslate()
  const selectLabelId = useId()
  const [accounts, setAccounts] = useState<ClaudeManagedAccountSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Why: bindings name this computer's folders, and only its own chats read them.
  const isLocal = getRepoExecutionHostId(repo) === 'local' && !repo.connectionId

  useEffect(() => {
    if (!isLocal) {
      return
    }
    let cancelled = false
    void window.api.claudeAccounts
      .list()
      .then((state) => {
        if (!cancelled) {
          setAccounts(state.accounts.filter((account) => account.managedAuthRuntime !== 'wsl'))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAccounts([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [isLocal])

  if (!isLocal) {
    return null
  }

  const save = async (binding: ClaudeAccountBinding | null) => {
    setSaving(true)
    setError(null)
    try {
      const result = await Promise.resolve(updateRepo(repo.id, { claudeAccount: binding }))
      if (result === false) {
        setError(
          t(
            'auto.components.settings.RepositoryClaudeAccountSection.saveFailed',
            'Could not save the Claude account for this project.'
          )
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onValueChange = async (value: string) => {
    if (value === bindingValue(repo.claudeAccount)) {
      return
    }
    if (value === SELECTION_VALUE) {
      await save(null)
      return
    }
    if (value === PICK_FOLDER_VALUE) {
      const configDir = await window.api.shell.pickDirectory(
        repo.claudeAccount?.kind === 'folder' ? { defaultPath: repo.claudeAccount.configDir } : {}
      )
      if (configDir) {
        await save({ kind: 'folder', configDir })
      }
      return
    }
    if (value.startsWith(ACCOUNT_PREFIX)) {
      await save({ kind: 'managed', accountId: value.slice(ACCOUNT_PREFIX.length) })
    }
  }

  const bound = repo.claudeAccount
  const boundAccountMissing =
    bound?.kind === 'managed' && !accounts.some((account) => account.id === bound.accountId)

  return (
    <SearchableSetting
      title={t('auto.components.settings.RepositoryClaudeAccountSection.title', 'Claude account')}
      description={t(
        'auto.components.settings.RepositoryClaudeAccountSection.description',
        'Run this project’s Claude chats on a specific account, whatever account is selected.'
      )}
      keywords={searchKeywords([repo.displayName, 'claude', 'claude account', 'config dir'], t)}
      className="space-y-3 py-3"
      forceVisible={forceVisible}
    >
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-semibold">
          {t('auto.components.settings.RepositoryClaudeAccountSection.title', 'Claude account')}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RepositoryClaudeAccountSection.longDescription',
            'New and resumed Claude chats in this project use this account, so chats in other projects can run on another account at the same time. A folder keeps its history apart from your other accounts.'
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <span id={selectLabelId} className="text-xs text-muted-foreground">
          {t('auto.components.settings.RepositoryClaudeAccountSection.selectLabel', 'Account')}
        </span>
        <Select
          value={bindingValue(bound)}
          disabled={saving}
          onValueChange={(value) => void onValueChange(value)}
        >
          <SelectTrigger size="sm" className="w-full" aria-labelledby={selectLabelId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SELECTION_VALUE}>
              {t(
                'auto.components.settings.RepositoryClaudeAccountSection.followSelection',
                'Follow the selected account'
              )}
            </SelectItem>
            {boundAccountMissing ? (
              <SelectItem value={bindingValue(bound)} disabled>
                {t(
                  'auto.components.settings.RepositoryClaudeAccountSection.missingAccount',
                  'Removed account'
                )}
              </SelectItem>
            ) : null}
            {accounts.map((account) => (
              <SelectItem key={account.id} value={`${ACCOUNT_PREFIX}${account.id}`}>
                {account.displayName ?? account.email}
              </SelectItem>
            ))}
            {bound?.kind === 'folder' ? (
              <SelectItem value={bindingValue(bound)}>{bound.configDir}</SelectItem>
            ) : null}
            <SelectItem value={PICK_FOLDER_VALUE}>
              {t(
                'auto.components.settings.RepositoryClaudeAccountSection.pickFolder',
                'Choose a config folder…'
              )}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SearchableSetting>
  )
}
