import type React from 'react'
import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../shared/constants'
import { clampNumber } from '@/lib/terminal-theme'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import {
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'

export type AutoSaveDelayDraftState = {
  sourceDelayMs: number
  draft: string
}

export function createAutoSaveDelayDraftState(
  editorAutoSaveDelayMs: number
): AutoSaveDelayDraftState {
  return {
    sourceDelayMs: editorAutoSaveDelayMs,
    draft: String(editorAutoSaveDelayMs)
  }
}

function resolveAutoSaveDelayDraftState(
  state: AutoSaveDelayDraftState,
  editorAutoSaveDelayMs: number
): AutoSaveDelayDraftState {
  return state.sourceDelayMs === editorAutoSaveDelayMs
    ? state
    : createAutoSaveDelayDraftState(editorAutoSaveDelayMs)
}

export function updateAutoSaveDelayDraftState(
  state: AutoSaveDelayDraftState,
  editorAutoSaveDelayMs: number,
  draft: string
): AutoSaveDelayDraftState {
  return {
    // Why: settings persistence is async, so a committed draft must stay tied
    // to the current source until the persisted value reloads.
    ...resolveAutoSaveDelayDraftState(state, editorAutoSaveDelayMs),
    draft
  }
}

type GeneralEditorSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralEditorSettingsSection({
  settings,
  updateSettings
}: GeneralEditorSettingsSectionProps): React.JSX.Element {
  const [autoSaveDelayDraftState, setAutoSaveDelayDraftState] = useState(() =>
    createAutoSaveDelayDraftState(settings.editorAutoSaveDelayMs)
  )

  const resolvedAutoSaveDelayDraftState = resolveAutoSaveDelayDraftState(
    autoSaveDelayDraftState,
    settings.editorAutoSaveDelayMs
  )
  if (resolvedAutoSaveDelayDraftState !== autoSaveDelayDraftState) {
    // Why: Settings can be updated outside this pane; reconcile drafts before
    // paint so the visible input never lags behind the persisted value.
    setAutoSaveDelayDraftState(resolvedAutoSaveDelayDraftState)
  }
  const autoSaveDelayDraft = resolvedAutoSaveDelayDraftState.draft

  const updateAutoSaveDelayDraft = (draft: string): void => {
    setAutoSaveDelayDraftState((current) =>
      updateAutoSaveDelayDraftState(current, settings.editorAutoSaveDelayMs, draft)
    )
  }

  const commitAutoSaveDelay = (): void => {
    const trimmed = autoSaveDelayDraft.trim()
    if (trimmed === '') {
      setAutoSaveDelayDraftState(createAutoSaveDelayDraftState(settings.editorAutoSaveDelayMs))
      return
    }

    const value = Number(trimmed)
    if (!Number.isFinite(value)) {
      setAutoSaveDelayDraftState(createAutoSaveDelayDraftState(settings.editorAutoSaveDelayMs))
      return
    }

    const next = clampNumber(
      Math.round(value),
      MIN_EDITOR_AUTO_SAVE_DELAY_MS,
      MAX_EDITOR_AUTO_SAVE_DELAY_MS
    )
    updateSettings({ editorAutoSaveDelayMs: next })
    setAutoSaveDelayDraftState((current) =>
      updateAutoSaveDelayDraftState(current, settings.editorAutoSaveDelayMs, String(next))
    )
  }

  return (
    <section key="editor" className="space-y-4">
      <SettingsSubsectionHeader
        title="Editor"
        description="Configure how Orca persists file edits."
      />

      <SearchableSetting
        title="Auto Save Files"
        description="Save editor and editable diff changes automatically after a short pause."
        keywords={['autosave', 'save']}
      >
        <SettingsSwitchRow
          label="Auto Save Files"
          description="Save editor and editable diff changes automatically after a short pause."
          checked={settings.editorAutoSave}
          onChange={() => updateSettings({ editorAutoSave: !settings.editorAutoSave })}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Auto Save Delay"
        description="How long Orca waits after your last edit before saving automatically."
        keywords={['autosave', 'delay', 'milliseconds']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>Auto Save Delay</Label>
          <p className="text-xs text-muted-foreground">
            How long Orca waits after your last edit before saving automatically. First launch
            defaults to {DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS} ms.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            type="number"
            min={MIN_EDITOR_AUTO_SAVE_DELAY_MS}
            max={MAX_EDITOR_AUTO_SAVE_DELAY_MS}
            step={250}
            value={autoSaveDelayDraft}
            onChange={(e) => updateAutoSaveDelayDraft(e.target.value)}
            onBlur={commitAutoSaveDelay}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitAutoSaveDelay()
              }
            }}
            className="number-input-clean w-28 text-right tabular-nums"
          />
          <span className="text-xs text-muted-foreground">ms</span>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title="Default Diff View"
        description="Preferred presentation format for showing git diffs by default."
        keywords={['diff', 'view', 'inline', 'side-by-side', 'split']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>Default Diff View</Label>
          <p className="text-xs text-muted-foreground">
            Preferred presentation format for showing git diffs by default.
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel="Default Diff View"
          value={settings.diffDefaultView}
          onChange={(option) => updateSettings({ diffDefaultView: option })}
          options={[
            { value: 'inline', label: 'Inline' },
            { value: 'side-by-side', label: 'Side-by-side' }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Default Diff File Tree"
        description="Show or hide the file tree when opening combined diff views."
        keywords={['diff', 'tree', 'file tree', 'combined diff', 'sidebar']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>Default Diff File Tree</Label>
          <p className="text-xs text-muted-foreground">
            Show or hide the file tree when opening combined diff views.
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel="Default Diff File Tree"
          value={settings.combinedDiffFileTreeVisibleByDefault ? 'shown' : 'hidden'}
          onChange={(option) =>
            updateSettings({ combinedDiffFileTreeVisibleByDefault: option === 'shown' })
          }
          options={[
            { value: 'shown', label: 'Shown' },
            { value: 'hidden', label: 'Hidden' }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Minimap"
        description="Show the minimap overview when editing a file."
        keywords={['minimap', 'overview', 'code', 'scroll']}
      >
        <SettingsSwitchRow
          label="Minimap"
          description="Show the minimap overview when editing a file."
          checked={settings.editorMinimapEnabled}
          onChange={() => updateSettings({ editorMinimapEnabled: !settings.editorMinimapEnabled })}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Markdown Review Notes"
        description="Show local markdown review note controls in rich editor mode."
        keywords={['markdown', 'review', 'notes', 'annotations', 'agents']}
      >
        <SettingsSwitchRow
          label="Markdown Review Notes"
          description="Show local markdown note controls in rich editor mode and agent handoff actions."
          checked={settings.markdownReviewToolsEnabled}
          onChange={() =>
            updateSettings({ markdownReviewToolsEnabled: !settings.markdownReviewToolsEnabled })
          }
        />
      </SearchableSetting>
    </section>
  )
}
