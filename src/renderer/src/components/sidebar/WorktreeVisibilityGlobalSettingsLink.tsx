import type React from 'react'
import { Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { useAppStore } from '@/store'
import type { WorktreeVisibilityDefaults } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  listInheritedWorktreeVisibilitySources,
  worktreeVisibilityValueLabel
} from './worktree-visibility-source-provenance'
import {
  getWorktreeVisibilitySourceLabel,
  worktreeVisibilitySourceRowKey
} from './WorktreeVisibilitySourceList'

function openGlobalWorktreeVisibilitySettings(): void {
  const store = useAppStore.getState()
  store.closeModal()
  store.openSettingsTarget({
    pane: 'general',
    repoId: null,
    sectionId: GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID
  })
  store.openSettingsPage()
}

function GlobalSettingsButton(): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto w-fit px-0"
      onClick={openGlobalWorktreeVisibilitySettings}
    >
      <Settings className="size-3.5" />
      {translate(
        'auto.components.sidebar.WorktreeVisibilityDialog.openGlobalSettings',
        'Manage in Global Settings'
      )}
    </Button>
  )
}

export function WorktreeVisibilityGlobalSettingsLink({
  repo,
  visibilityDefaults
}: {
  repo: Repo
  visibilityDefaults?: WorktreeVisibilityDefaults
}): React.JSX.Element {
  const inherited = listInheritedWorktreeVisibilitySources(repo, visibilityDefaults)
  if (inherited.length === 0) {
    return <GlobalSettingsButton />
  }

  return (
    <div className="grid gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.sidebar.WorktreeVisibilityDialog.globalSettingsSources',
          'These sources have a global setting you can override here:'
        )}
      </p>
      <ul className="grid grid-cols-[max-content_max-content] gap-x-3.5 gap-y-0.5">
        {inherited.map(({ source, globalVisibility }) => (
          <li key={worktreeVisibilitySourceRowKey(source)} className="contents">
            <span className="truncate font-mono text-[11px] text-foreground/85">
              {getWorktreeVisibilitySourceLabel(source)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {worktreeVisibilityValueLabel(globalVisibility)}
            </span>
          </li>
        ))}
      </ul>
      <GlobalSettingsButton />
    </div>
  )
}
