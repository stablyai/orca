import { useId, useState, type FormEvent } from 'react'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  parseIssueRepository,
  type IssueRepository
} from '../../../../../shared/github/repositories/github-issue-reference'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import type { SettingsSearchEntry } from '../search/settings-search'

export function getRepositoryGitHubIssueSearchEntry(repo: Repo, t: Translate): SettingsSearchEntry {
  return {
    title: t('components.RepositoryGitHubIssueSection.title', 'Default GitHub issue repository'),
    description: t(
      'components.RepositoryGitHubIssueSection.description',
      'Use this repository when linking a GitHub issue by number. Leave blank to use the project repository.'
    ),
    keywords: [
      repo.displayName,
      t('components.RepositoryGitHubIssueSection.placeholder', 'owner/repo')
    ]
  }
}

export function RepositoryGitHubIssueSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (
    id: string,
    updates: { defaultIssueRepository: IssueRepository | null }
  ) => void | Promise<boolean>
  forceVisible?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getRepositoryGitHubIssueSearchEntry(repo, t)
  const inputId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'invalid' | 'save' | 'runtime' | null>(null)
  const current = repo.defaultIssueRepository
    ? `${repo.defaultIssueRepository.owner}/${repo.defaultIssueRepository.repo}`
    : ''
  const text = draft ?? current
  const value = text.trim()

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (saving || value === current) {
      return
    }
    const repository = value ? parseIssueRepository(value) : null
    if (repository === undefined) {
      setError('invalid')
      return
    }
    setError(null)
    setSaving(true)
    try {
      if ((await updateRepo(repo.id, { defaultIssueRepository: repository })) === false) {
        setError('save')
        return
      }
      const hostId = getRepoExecutionHostId(repo)
      const echoed = useAppStore
        .getState()
        .repos.find(
          (entry) => entry.id === repo.id && getRepoExecutionHostId(entry) === hostId
        )?.defaultIssueRepository
      if (echoed?.owner !== repository?.owner || echoed?.repo !== repository?.repo) {
        setError('runtime')
        return
      }
      setDraft(null)
    } catch {
      setError('save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SearchableSetting {...entry} forceVisible={forceVisible} className="py-3">
      <form onSubmit={(event) => void save(event)} className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor={inputId}>{entry.title}</Label>
          <p id={`${inputId}-description`} className="text-settings-detail text-muted-foreground">
            {entry.description}
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={text}
            placeholder={t('components.RepositoryGitHubIssueSection.placeholder', 'owner/repo')}
            autoCapitalize="none"
            spellCheck={false}
            disabled={saving}
            aria-invalid={error === 'invalid'}
            aria-describedby={`${inputId}-description${error ? ` ${inputId}-error` : ''}`}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
          />
          <Button type="submit" disabled={saving || value === current}>
            {t('components.RepositoryGitHubIssueSection.save', 'Save')}
          </Button>
        </div>
        {error ? (
          <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
            {error === 'invalid'
              ? t(
                  'components.RepositoryGitHubIssueSection.invalid',
                  'Enter a GitHub repository in owner/repo format.'
                )
              : error === 'runtime'
                ? t(
                    'components.RepositoryGitHubIssueSection.runtimeUpdate',
                    'Update this runtime to save a default GitHub issue repository.'
                  )
                : t(
                    'components.RepositoryGitHubIssueSection.saveFailed',
                    'Could not save the default GitHub issue repository.'
                  )}
          </p>
        ) : null}
      </form>
    </SearchableSetting>
  )
}
