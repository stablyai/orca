import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { normalizeGitLabUrl } from '../../../../shared/gitlab-instance-url'
import { translate } from '@/i18n/i18n'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

const GITLAB_URL_TITLE = 'GitLab URL'
const GITLAB_URL_DESCRIPTION = 'Orca uses this single URL for GitLab operations.'
const GITLAB_URL_KEYWORDS = ['gitlab', 'gitlab url', 'self-hosted', 'instance', 'server']

type GitLabUrlSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function gitLabUrlSettingMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: GITLAB_URL_TITLE,
    description: GITLAB_URL_DESCRIPTION,
    keywords: GITLAB_URL_KEYWORDS
  })
}

export function GitLabUrlSetting({
  settings,
  updateSettings
}: GitLabUrlSettingProps): React.JSX.Element {
  const title = translate('auto.components.settings.GitLabUrlSetting.title', GITLAB_URL_TITLE)
  const description = translate(
    'auto.components.settings.GitLabUrlSetting.description',
    GITLAB_URL_DESCRIPTION
  )
  const gitlabUrl = settings.gitlabUrl ?? ''
  // Why: commit on blur, not per keystroke — a half-typed URL would otherwise
  // be persisted and re-route every GitLab request while the user is typing.
  const [draft, setDraft] = useState(gitlabUrl)
  useEffect(() => setDraft(gitlabUrl), [gitlabUrl])

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={GITLAB_URL_KEYWORDS}
      className="space-y-2"
    >
      <div className="space-y-1">
        <Label htmlFor="gitlab-url">{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        id="gitlab-url"
        type="url"
        value={draft}
        placeholder="https://gitlab.example.com"
        spellCheck={false}
        className="max-w-md"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          // Why: show the stored value back, so a URL the main process
          // rejects doesn't linger in the field looking saved.
          const normalized = normalizeGitLabUrl(draft)
          setDraft(normalized)
          if (normalized !== gitlabUrl) {
            void updateSettings({ gitlabUrl: normalized })
          }
        }}
      />
    </SearchableSetting>
  )
}
