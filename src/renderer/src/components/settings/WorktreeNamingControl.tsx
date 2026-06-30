import React, { useEffect, useId, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export type WorktreeNamingMode = 'flat' | 'nested' | 'custom'

type WorktreeNamingControlProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: the naming mode dropdown is the single UI control for worktree folder
// layout. Each option writes the full set of related fields in one update so
// the runtime, persistence history, and legacy readers all stay in sync.
export function WorktreeNamingControl({
  settings,
  updateSettings
}: WorktreeNamingControlProps): React.JSX.Element {
  const inputId = useId()
  const mode: WorktreeNamingMode = settings.worktreeNamingMode ?? 'nested'
  const customFormat = settings.worktreeNameFormat ?? ''

  // Why: settings.ts triggers prepareLocalWorktreeRootsForRepos on every
  // worktreeNameFormat change, so commit on blur/Enter — not on each keystroke
  // — matching the workspaceDir draft pattern in WorkspaceDirectorySetting.
  const [draftFormat, setDraftFormat] = useState(customFormat)
  const draftFormatRef = useRef(customFormat)
  useEffect(() => {
    setDraftFormat(customFormat)
    draftFormatRef.current = customFormat
  }, [customFormat])

  const commitFormat = (): void => {
    const next = draftFormatRef.current
    if (next === customFormat) {
      return
    }
    updateSettings({ worktreeNameFormat: next || undefined })
  }

  const selectMode = (next: WorktreeNamingMode): void => {
    if (next === 'flat') {
      updateSettings({
        worktreeNamingMode: 'flat',
        worktreeNameFormat: undefined
      })
      return
    }
    if (next === 'nested') {
      updateSettings({
        worktreeNamingMode: 'nested',
        worktreeNameFormat: undefined
      })
      return
    }
    // custom: keep whatever format the user had, or default to a flat example
    // so the input is not empty on first switch.
    const seed =
      customFormat && customFormat !== '{repoName}/{name}' ? customFormat : '{repoName}.{name}'
    updateSettings({
      worktreeNamingMode: 'custom',
      worktreeNameFormat: seed
    })
  }

  const example = renderWorktreeNameExample(
    mode,
    draftFormat || customFormat,
    settings.workspaceDir
  )

  return (
    <div className="space-y-2">
      <SettingsRow
        label={translate(
          'auto.components.settings.WorkspaceDirectorySetting.7a8b9c0dae',
          'Worktree Naming'
        )}
        description={
          <>
            <span>
              {mode === 'flat' &&
                translate(
                  'auto.components.settings.WorkspaceDirectorySetting.c3d4e5f6ab',
                  'Worktrees are created directly under the workspace directory.'
                )}
              {mode === 'nested' &&
                translate(
                  'auto.components.settings.WorkspaceDirectorySetting.d4e5f6a7bc',
                  'Worktrees are grouped under a repo-named subfolder.'
                )}
              {mode === 'custom' &&
                translate(
                  'auto.components.settings.WorkspaceDirectorySetting.e5f6a7b8cd',
                  'Use {repoName} (or {repo}) and {name} (or {branch}) placeholders. A / in the format creates nested folders.'
                )}
            </span>
            <span className="block">
              {translate(
                'auto.components.settings.WorkspaceDirectorySetting.f6a7b8c9de',
                'Example'
              )}
              : <code className="text-xs">{example}</code>
            </span>
          </>
        }
        control={
          <Select value={mode} onValueChange={(v) => selectMode(v as WorktreeNamingMode)}>
            <SelectTrigger id={`${inputId}-mode`} className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="flat">
                {translate('auto.components.settings.WorkspaceDirectorySetting.9a0b1c2dbe', 'Flat')}
              </SelectItem>
              <SelectItem value="nested">
                {translate(
                  'auto.components.settings.WorkspaceDirectorySetting.a1b2c3d4ef',
                  'Nested by repo'
                )}
              </SelectItem>
              <SelectItem value="custom">
                {translate(
                  'auto.components.settings.WorkspaceDirectorySetting.b2c3d4e5fa',
                  'Custom format…'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {mode === 'custom' && (
        <Input
          id={`${inputId}-format`}
          value={draftFormat}
          placeholder="{repoName}.{name}"
          onChange={(e) => {
            draftFormatRef.current = e.target.value
            setDraftFormat(e.target.value)
          }}
          onBlur={commitFormat}
          onKeyDown={(e) => {
            if (isComposingKeyboardEvent(e)) {
              return
            }
            if (e.key === 'Enter') {
              e.currentTarget.blur()
              return
            }
            if (e.key === 'Escape') {
              draftFormatRef.current = customFormat
              setDraftFormat(customFormat)
              e.currentTarget.blur()
            }
          }}
          className="text-xs"
        />
      )}
    </div>
  )
}

// Why: render an illustrative example so users see how their format resolves
// before creating a worktree. Uses a sample repo/worktree name; the real path
// is computed at creation time by computeWorktreePath in the main process.
function renderWorktreeNameExample(
  mode: WorktreeNamingMode,
  customFormat: string,
  workspaceDir: string
): string {
  const repoName = 'my-project'
  const name = 'fix-bug'
  let relative: string
  if (mode === 'flat') {
    relative = name
  } else if (mode === 'nested') {
    relative = `${repoName}/${name}`
  } else {
    relative =
      customFormat
        .replace(/\{repoName\}/g, repoName)
        .replace(/\{repo\}/g, repoName)
        .replace(/\{name\}/g, name)
        .replace(/\{branch\}/g, name) || name
  }
  return `${workspaceDir.replace(/\/$/, '')}/${relative}`
}

function isComposingKeyboardEvent(event: React.KeyboardEvent<HTMLInputElement>): boolean {
  const nativeEvent = event.nativeEvent
  return nativeEvent.isComposing || nativeEvent.keyCode === 229
}
