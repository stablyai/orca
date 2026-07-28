import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

const GITLAB_URL_TITLE = 'GitLab URL'
const GITLAB_URL_DESCRIPTION = 'Orca uses this single URL for GitLab operations.'
const GITLAB_URL_KEYWORDS = ['gitlab', 'gitlab url', 'self-hosted', 'instance', 'server']

type GitLabSettings = GlobalSettings & { gitlabUrl?: string }
type GitLabSettingsPatch = Partial<GlobalSettings> & { gitlabUrl?: string }

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
          const patch: GitLabSettingsPatch = { gitlabUrl: draft }
          void updateSettings(patch)
        }}
      />
    </SearchableSetting>
  )
}
