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
    // Why: pick with no defaultPath applied here — seeding this picker with the
    // value being edited would be circular. Seed from the current value only.
    const picked = await window.api.repos.pickFolder(
      draftRef.current ? { defaultPath: draftRef.current } : undefined
    )
    if (picked) {
      setDraftValue(picked)
      commit(picked)
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ProjectDefaultPathSetting.title',
        'Project default directory'
      )}
      description={translate(
        'auto.components.settings.ProjectDefaultPathSetting.description',
        'Where the add-project and clone folder pickers open. Leave empty to use the last-used location.'
      )}
    >
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="sr-only">
          {translate(
            'auto.components.settings.ProjectDefaultPathSetting.title',
            'Project default directory'
          )}
        </Label>
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
        <Button type="button" variant="outline" size="icon" onClick={() => void handleBrowse()}>
          <FolderOpen className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={translate(
            'auto.components.settings.ProjectDefaultPathSetting.clear',
            'Clear'
          )}
          onClick={() => {
            setDraftValue('')
            commit('')
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
    </SearchableSetting>
  )
}
