import React, { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, RotateCcw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  getEffectiveHostSetting,
  getHostSettingOverride,
  setHostSettingOverride,
  clearHostSettingOverride
} from '../../../../shared/host-setting-overrides'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'
import {
  buildHostScopeChoices,
  CLIENT_DEFAULT_SCOPE,
  isHostScope,
  type HostSettingScope
} from './host-scoped-setting-scope'
import { translate } from '@/i18n/i18n'

type WorkspaceDirectorySettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WorkspaceDirectorySetting({
  settings,
  updateSettings
}: WorkspaceDirectorySettingProps): React.JSX.Element {
  const { hostOptions } = useSidebarHostScopeOptions()
  const [scope, setScope] = useState<HostSettingScope>(CLIENT_DEFAULT_SCOPE)
  const inputId = useId()

  const clientDefaultLabel = translate(
    'auto.components.settings.WorkspaceDirectorySetting.1a2b3c4d5e',
    'Client default'
  )
  const choices = buildHostScopeChoices(hostOptions, clientDefaultLabel)
  // Why: if the selected host disappears (removed/disconnected), fall back to the
  // client default so the control never edits a stale host.
  const activeScope = choices.some((c) => c.scope === scope) ? scope : CLIENT_DEFAULT_SCOPE
  const editingHost = isHostScope(activeScope)

  const hostOverride = editingHost
    ? getHostSettingOverride(settings, activeScope, 'defaultWorktreeLocation')
    : undefined
  const hasOverride = editingHost && hostOverride !== undefined

  // For a host scope, show its override or — as a hint — the inherited client
  // default. For the client default scope, edit `workspaceDir` directly.
  const value = editingHost
    ? getEffectiveHostSetting(
        settings,
        activeScope,
        'defaultWorktreeLocation',
        settings.workspaceDir
      )
    : settings.workspaceDir
  // Why: settings:set prepares the workspace root with mkdir; committing each
  // keystroke would create every typed path prefix as a real directory.
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
    if (!editingHost) {
      updateSettings({ workspaceDir: next })
      return
    }
    updateSettings({
      hostSettingOverrides: setHostSettingOverride(
        settings,
        activeScope,
        'defaultWorktreeLocation',
        next
      )
    })
  }

  const commitDraftValue = (): void => {
    const next = draftValueRef.current
    if (next === value) {
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

  const resetOverride = (): void => {
    if (!editingHost) {
      return
    }
    updateSettings({
      hostSettingOverrides: clearHostSettingOverride(
        settings,
        activeScope,
        'defaultWorktreeLocation'
      )
    })
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

  // Why: only show the scope picker when at least one non-local host exists,
  // matching the multi-host gating used elsewhere in the sidebar.
  const showScopePicker = hostOptions.some((host) => host.id !== LOCAL_EXECUTION_HOST_ID)

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.0e9fc0eadc',
        'Workspace Directory'
      )}
      description={translate(
        'auto.components.settings.GeneralWorkspaceSettingsSection.a246f5ce6f',
        'Root directory where workspace folders are created.'
      )}
      keywords={['workspace', 'folder', 'path', 'worktree', 'host', 'override']}
      className="space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>
          {translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.0e9fc0eadc',
            'Workspace Directory'
          )}
        </Label>
        {showScopePicker && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.WorkspaceDirectorySetting.2b3c4d5e6f',
                'Apply to'
              )}
            </span>
            <Select
              value={activeScope}
              onValueChange={(next) => setScope(next as HostSettingScope)}
            >
              <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.scope} value={choice.scope} className="text-xs">
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draftValue}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (isComposingKeyboardEvent(e)) {
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
      {editingHost && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {hasOverride
              ? translate(
                  'auto.components.settings.WorkspaceDirectorySetting.3c4d5e6f7a',
                  'Overrides client default'
                )
              : translate(
                  'auto.components.settings.WorkspaceDirectorySetting.4d5e6f7a8b',
                  'Inherits the client default'
                )}
          </p>
          {hasOverride && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={resetOverride}
            >
              <RotateCcw className="size-3.5" />
              {translate('auto.components.settings.WorkspaceDirectorySetting.5e6f7a8b9c', 'Reset')}
            </Button>
          )}
        </div>
      )}
      {/* Why: this helper documents the client-default workspaceDir resolver;
          avoid promising host-specific creation semantics here. */}
      {!editingHost && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.WorkspaceDirectorySetting.6f7a8b9cad',
            'Use a relative path (e.g. .orca/worktrees) for a per-project location, or an absolute path for one shared folder.'
          )}
        </p>
      )}
      {!editingHost && (
        <WorktreeNamingControl settings={settings} updateSettings={updateSettings} />
      )}
    </SearchableSetting>
  )
}

function isComposingKeyboardEvent(event: React.KeyboardEvent<HTMLInputElement>): boolean {
  const nativeEvent = event.nativeEvent
  return nativeEvent.isComposing || nativeEvent.keyCode === 229
}

type WorktreeNamingMode = 'flat' | 'nested' | 'custom'

type WorktreeNamingControlProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: the naming mode dropdown is the single UI control for worktree folder
// layout. Each option writes the full set of related fields in one update so
// the runtime, persistence history, and legacy readers all stay in sync.
function WorktreeNamingControl({
  settings,
  updateSettings
}: WorktreeNamingControlProps): React.JSX.Element {
  const inputId = useId()
  const mode: WorktreeNamingMode = settings.worktreeNamingMode ?? 'nested'
  const customFormat = settings.worktreeNameFormat ?? ''

  const selectMode = (next: WorktreeNamingMode): void => {
    if (next === 'flat') {
      updateSettings({
        worktreeNamingMode: 'flat',
        nestWorkspaces: false,
        worktreeNameFormat: undefined
      })
      return
    }
    if (next === 'nested') {
      // Why: nested is a format preset so the runtime uses one code path;
      // nestWorkspaces stays true for back-compat with legacy readers.
      updateSettings({
        worktreeNamingMode: 'nested',
        nestWorkspaces: true,
        worktreeNameFormat: '{repoName}/{name}'
      })
      return
    }
    // custom: keep whatever format the user had, or default to a flat example
    // so the input is not empty on first switch.
    const seed =
      customFormat && customFormat !== '{repoName}/{name}' ? customFormat : '{repoName}.{name}'
    updateSettings({
      worktreeNamingMode: 'custom',
      nestWorkspaces: false,
      worktreeNameFormat: seed
    })
  }

  const setCustomFormat = (value: string): void => {
    updateSettings({ worktreeNameFormat: value || undefined })
  }

  const preview = renderWorktreeNamePreview(mode, customFormat, settings.workspaceDir)

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${inputId}-mode`}>
        {translate(
          'auto.components.settings.WorkspaceDirectorySetting.7a8b9c0dae',
          'Worktree Naming'
        )}
      </Label>
      <Select value={mode} onValueChange={(v) => selectMode(v as WorktreeNamingMode)}>
        <SelectTrigger id={`${inputId}-mode`} size="sm" className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="flat" className="text-xs">
            {translate(
              'auto.components.settings.WorkspaceDirectorySetting.9a0b1c2dbe',
              'Flat — /workspaces/{name}'
            )}
          </SelectItem>
          <SelectItem value="nested" className="text-xs">
            {translate(
              'auto.components.settings.WorkspaceDirectorySetting.a1b2c3d4ef',
              'Nested by repo — /workspaces/{repoName}/{name}'
            )}
          </SelectItem>
          <SelectItem value="custom" className="text-xs">
            {translate(
              'auto.components.settings.WorkspaceDirectorySetting.b2c3d4e5fa',
              'Custom format…'
            )}
          </SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
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
      </p>
      {mode === 'custom' && (
        <div className="space-y-1.5">
          <Input
            id={`${inputId}-format`}
            value={customFormat}
            placeholder="{repoName}.{name}"
            onChange={(e) => setCustomFormat(e.target.value)}
            className="text-xs"
          />
          {preview && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.WorkspaceDirectorySetting.f6a7b8c9de',
                'Preview'
              )}
              : <code className="text-xs">{preview}</code>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// Why: render an illustrative preview so users see how their format resolves
// before creating a worktree. Uses a sample repo/worktree name; the real path
// is computed at creation time by computeWorktreePath in the main process.
function renderWorktreeNamePreview(
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
