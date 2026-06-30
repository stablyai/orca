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
    </SearchableSetting>
  )
}

function isComposingKeyboardEvent(event: React.KeyboardEvent<HTMLInputElement>): boolean {
  const nativeEvent = event.nativeEvent
  return nativeEvent.isComposing || nativeEvent.keyCode === 229
}
