import { useEffect, useState } from 'react'
import type { ClaudeAccountBinding } from '../../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { ClaudeManagedAccountSummary } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { searchKeywords } from '../../search/settings-search-keywords'
import { ClaudeAccountBindingSelect } from './ClaudeAccountBindingSelect'

type RepositoryClaudeAccountSectionProps = {
  repo: Repo
  updateRepo: (repoId: string, updates: { claudeAccount?: ClaudeAccountBinding | null }) => unknown
  forceVisible?: boolean
}

/** Null when saved; 'refused' when the host declined; else the thrown message. */
async function bindingWriteFailure(write: () => unknown): Promise<string | null> {
  try {
    return (await Promise.resolve(write())) === false ? 'refused' : null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function RepositoryClaudeAccountSection({
  repo,
  updateRepo,
  forceVisible
}: RepositoryClaudeAccountSectionProps): React.JSX.Element | null {
  const t = useTranslate()
  const [accounts, setAccounts] = useState<ClaudeManagedAccountSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const group = useAppStore((state) =>
    repo.projectGroupId
      ? state.projectGroups.find((candidate) => candidate.id === repo.projectGroupId)
      : undefined
  )
  const updateProjectGroup = useAppStore((state) => state.updateProjectGroup)
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

  const save = async (write: () => unknown) => {
    setSaving(true)
    setError(null)
    const failure = await bindingWriteFailure(write)
    setSaving(false)
    setError(
      failure === 'refused'
        ? t(
            'auto.components.settings.RepositoryClaudeAccountSection.saveFailed',
            'Could not save the Claude account for this project.'
          )
        : failure
    )
  }

  const followSelection = t(
    'auto.components.settings.RepositoryClaudeAccountSection.followSelection',
    'Follow the selected account'
  )

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

      <ClaudeAccountBindingSelect
        label={t('auto.components.settings.RepositoryClaudeAccountSection.selectLabel', 'Account')}
        unboundLabel={
          group?.claudeAccount
            ? t(
                'auto.components.settings.RepositoryClaudeAccountSection.useGroup',
                'Use the group’s account'
              )
            : followSelection
        }
        binding={repo.claudeAccount}
        accounts={accounts}
        disabled={saving}
        onChange={(binding) => void save(() => updateRepo(repo.id, { claudeAccount: binding }))}
      />
      {group ? (
        <ClaudeAccountBindingSelect
          label={t(
            'auto.components.settings.RepositoryClaudeAccountSection.groupLabel',
            'Default for the projects in {{group}}',
            { group: group.name }
          )}
          unboundLabel={followSelection}
          binding={group.claudeAccount}
          accounts={accounts}
          disabled={saving}
          onChange={(binding) =>
            void save(() => updateProjectGroup(group.id, { claudeAccount: binding }))
          }
        />
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SearchableSetting>
  )
}
