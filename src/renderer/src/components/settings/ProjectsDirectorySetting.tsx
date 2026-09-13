import React, { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'

type ProjectsDirectorySettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/**
 * Default parent folder for "Create new project" on the local host. Blank means
 * "inherit": the main-process resolver then falls back to Workspace Directory and
 * finally `~/orca/projects` (see `getDefaultCreateProjectParent`).
 *
 * Why a separate setting: Workspace Directory is where worktrees are created, and
 * many users keep their projects in a different tree. Reusing it would force both
 * into one folder (orca#20475).
 */
export function ProjectsDirectorySetting({
  settings,
  updateSettings
}: ProjectsDirectorySettingProps): React.JSX.Element {
  const inputId = useId()
  const value = settings.projectsDir ?? ''
  // Why: commit on blur/Enter rather than per keystroke so a half-typed path is
  // never persisted, matching WorkspaceDirectorySetting.
  const [draftValue, setDraftValue] = useState(value)
  const draftValueRef = useRef(value)
  const skipNextBlurCommitRef = useRef(false)

  useEffect(() => {
    setDraftValue(value)
    draftValueRef.current = value
  }, [value])

  const setDraft = (next: string): void => {
    draftValueRef.current = next
    setDraftValue(next)
  }

  const writeValue = (next: string): void => {
    updateSettings({ projectsDir: next.trim() })
  }

  const commitDraftValue = (): void => {
    const next = draftValueRef.current
    if (next.trim() === value) {
      return
    }
    writeValue(next)
  }

  const handleBlur = (): void => {
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false
      return
    }
    commitDraftValue()
  }

  const resetDraftValue = (): void => {
    setDraft(value)
  }

  const handleBrowse = async (): Promise<void> => {
    try {
      const path = await window.api.repos.pickFolder()
      if (path) {
        setDraft(path)
        writeValue(path)
        return
      }
      resetDraftValue()
    } finally {
      skipNextBlurCommitRef.current = false
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ProjectsDirectorySetting.36a4a03baf',
        'Projects Directory'
      )}
      description={translate(
        'auto.components.settings.ProjectsDirectorySetting.bd7ac2af54',
        'Default parent folder for Create new project. Leave empty to use the Workspace Directory, or ~/orca/projects when that is still the default.'
      )}
      keywords={['project', 'projects', 'folder', 'path', 'create', 'location', 'parent']}
      className="space-y-2"
    >
      <Label htmlFor={inputId}>
        {translate(
          'auto.components.settings.ProjectsDirectorySetting.36a4a03baf',
          'Projects Directory'
        )}
      </Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draftValue}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            // Why: an Enter that only confirms a CJK IME candidate must not
            // commit the value; wait for a non-composition Enter.
            if (isImeCompositionKeyDown(e)) {
              return
            }
            if (e.key === 'Enter') {
              skipNextBlurCommitRef.current = true
              commitDraftValue()
              e.currentTarget.blur()
              return
            }
            if (e.key === 'Escape') {
              skipNextBlurCommitRef.current = true
              resetDraftValue()
              e.currentTarget.blur()
            }
          }}
          className="flex-1 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          onPointerDown={() => {
            skipNextBlurCommitRef.current = true
          }}
          onClick={() => void handleBrowse()}
          className="shrink-0 gap-1.5"
        >
          <FolderOpen className="size-3.5" />
          {translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.5567191a6e',
            'Browse'
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ProjectsDirectorySetting.bd7ac2af54',
          'Default parent folder for Create new project. Leave empty to use the Workspace Directory, or ~/orca/projects when that is still the default.'
        )}
      </p>
    </SearchableSetting>
  )
}
