import React, { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, RotateCcw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'

type ProjectDefaultPathSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function ProjectDefaultPathSetting({
  settings,
  updateSettings
}: ProjectDefaultPathSettingProps): React.JSX.Element {
  const inputId = useId()
  const value = settings.projectDefaultPath ?? ''
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)

  useEffect(() => {
    setDraft(value)
    draftRef.current = value
  }, [value])

  const setDraftValue = (next: string): void => {
    draftRef.current = next
    setDraft(next)
  }

  const commit = (next: string): void => {
    if (next === value) {
      return
    }
    updateSettings({ projectDefaultPath: next })
  }

  const handleBrowse = async (): Promise<void> => {
    // Why: seed the picker with the current draft so re-browsing starts near the
    // in-progress edit. When the draft is empty, the main-process handler falls
    // back to the saved projectDefaultPath setting on its own.
    const picked = await window.api.repos.pickFolder(
      draftRef.current ? { defaultPath: draftRef.current } : undefined
    )
    if (picked) {
      setDraftValue(picked)
      commit(picked)
    }
  }

  const title = translate(
    'auto.components.settings.ProjectDefaultPathSetting.title',
    'Project default directory'
  )
  const description = translate(
    'auto.components.settings.ProjectDefaultPathSetting.description',
    'Where the add-project and clone folder pickers open. Leave empty to use the last-used location.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['project', 'default', 'directory', 'folder', 'path', 'clone', 'location']}
      className="space-y-2"
    >
      <Label htmlFor={inputId}>{title}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={draft}
          placeholder="/Users/you/dev"
          onChange={(e) => setDraftValue(e.target.value)}
          onBlur={() => commit(draftRef.current)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isImeCompositionKeyDown(e)) {
              commit(draftRef.current)
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.5567191a6e',
            'Browse'
          )}
          onClick={() => void handleBrowse()}
        >
          <FolderOpen className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={translate(
            'auto.components.settings.ProjectDefaultPathSetting.reset',
            'Reset'
          )}
          onClick={() => {
            setDraftValue('')
            commit('')
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </SearchableSetting>
  )
}
