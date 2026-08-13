import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

export const COMBINE_UNTRACKED_CHANGES_KEYWORDS = [
  'combine untracked',
  'untracked files',
  'merge untracked',
  'source control',
  'git changes'
]

function getCombineUntrackedChangesTitle(): string {
  return translate(
    'auto.components.settings.GitPane.combineUntrackedChangesTitle',
    'Combine Untracked with Changes'
  )
}

function getCombineUntrackedChangesDescription(): string {
  return translate(
    'auto.components.settings.GitPane.combineUntrackedChangesDescription',
    'Show untracked files inside the Changes section instead of their own Untracked Files section.'
  )
}

export function combineUntrackedChangesMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getCombineUntrackedChangesTitle(),
    description: getCombineUntrackedChangesDescription(),
    keywords: COMBINE_UNTRACKED_CHANGES_KEYWORDS
  })
}

export function CombineUntrackedWithChangesSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const enabled = settings.sourceControlCombineUntrackedChanges ?? false
  const title = getCombineUntrackedChangesTitle()
  const description = getCombineUntrackedChangesDescription()

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={COMBINE_UNTRACKED_CHANGES_KEYWORDS}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        onClick={() => updateSettings({ sourceControlCombineUntrackedChanges: !enabled })}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
          enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </SearchableSetting>
  )
}
