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
  const skipNextBlurCommitRef = useRef(false)

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

  const handleBlur = (): void => {
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false
      return
    }
    commit(draftRef.current)
  }

  const handleBrowse = async (): Promise<void> => {
    try {
      // Why: seed the picker from the in-progress edit instead of an older
      // persisted value when the user browses before leaving the field.
      const picked = await window.api.repos.pickFolder({ defaultPath: draftRef.current })
      if (picked) {
        setDraftValue(picked)
        commit(picked)
      }
    } finally {
      skipNextBlurCommitRef.current = false
    }
  }

  const title = translate(
    'auto.components.settings.ProjectDefaultPathSetting.title',
    'Project default directory'
  )
  // Why: native pickers browse the client filesystem; SSH/runtime project
  // paths remain typed host paths and never inherit this local directory.
  const description = translate(
    'auto.components.settings.ProjectDefaultPathSetting.description',
    "Starting directory for local project folder pickers. Leave empty to use the system's last-used location."
  )
  const browseLabel = translate(
    'auto.components.settings.ProjectDefaultPathSetting.browse',
    'Browse'
  )
  const resetLabel = translate('auto.components.settings.ProjectDefaultPathSetting.reset', 'Reset')
  // Why: show a path example that matches the user's OS so the placeholder reads
  // naturally on Windows as well as macOS/Linux.
  const placeholder =
    window.api.platform.get().platform === 'win32' ? 'C:\\Users\\you\\dev' : '/Users/you/dev'

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
          placeholder={placeholder}
          onChange={(e) => setDraftValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (isImeCompositionKeyDown(e)) {
              return
            }
            if (e.key === 'Enter') {
              skipNextBlurCommitRef.current = true
              commit(draftRef.current)
              e.currentTarget.blur()
              return
            }
            if (e.key === 'Escape') {
              skipNextBlurCommitRef.current = true
              setDraftValue(value)
              e.currentTarget.blur()
            }
          }}
          className="flex-1 text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onPointerDown={() => {
            skipNextBlurCommitRef.current = true
          }}
          onClick={() => void handleBrowse()}
          className="shrink-0 gap-1.5"
        >
          <FolderOpen className="size-3.5" />
          {browseLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!draft && !value}
          onPointerDown={() => {
            skipNextBlurCommitRef.current = true
          }}
          onClick={() => {
            setDraftValue('')
            commit('')
            skipNextBlurCommitRef.current = false
          }}
          className="shrink-0 gap-1.5"
        >
          <RotateCcw className="size-3.5" />
          {resetLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </SearchableSetting>
  )
}
