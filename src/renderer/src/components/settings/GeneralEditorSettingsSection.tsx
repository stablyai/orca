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
import { translate } from '@/i18n/i18n'
import {
  createAutoSaveDelayDraftState,
  resolveAutoSaveDelayDraftState,
  updateAutoSaveDelayDraftState
} from './auto-save-delay-draft-state'
import { RichMarkdownSpellcheckSetting } from './RichMarkdownSpellcheckSetting'

export {
  createAutoSaveDelayDraftState,
  updateAutoSaveDelayDraftState,
  type AutoSaveDelayDraftState
} from './auto-save-delay-draft-state'

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
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.45c6e85c4d',
          'Editor'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.d21136d9ef',
          'Configure how Orca persists file edits.'
        )}
      />

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.0df2e4fd12',
          'Auto Save Files'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.70bb30feb1',
          'Save editor and editable diff changes automatically after a short pause.'
        )}
        keywords={['autosave', 'save']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.GeneralEditorSettingsSection.0df2e4fd12',
            'Auto Save Files'
          )}
          description={translate(
            'auto.components.settings.GeneralEditorSettingsSection.70bb30feb1',
            'Save editor and editable diff changes automatically after a short pause.'
          )}
          checked={settings.editorAutoSave}
          onChange={() => updateSettings({ editorAutoSave: !settings.editorAutoSave })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.d6cf227ca0',
          'Auto Save Delay'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.1bec6d8318',
          'How long Orca waits after your last edit before saving automatically.'
        )}
        keywords={['autosave', 'delay', 'milliseconds']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.d6cf227ca0',
              'Auto Save Delay'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.8112cd6dcf',
              'How long Orca waits after your last edit before saving automatically. First launch defaults to'
            )}
            {DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS}{' '}
            {translate('auto.components.settings.GeneralEditorSettingsSection.fc5c5306ff', 'ms.')}
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
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.settings.GeneralEditorSettingsSection.a5db1d3975', 'ms')}
          </span>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.7311f67ee7',
          'Default Diff View'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.b492397d34',
          'Preferred presentation format for showing git diffs by default.'
        )}
        keywords={['diff', 'view', 'inline', 'side-by-side', 'split']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.7311f67ee7',
              'Default Diff View'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.b492397d34',
              'Preferred presentation format for showing git diffs by default.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel={translate(
            'auto.components.settings.GeneralEditorSettingsSection.7311f67ee7',
            'Default Diff View'
          )}
          value={settings.diffDefaultView}
          onChange={(option) => updateSettings({ diffDefaultView: option })}
          options={[
            {
              value: 'inline',
              label: translate(
                'auto.components.settings.GeneralEditorSettingsSection.05b6df93b3',
                'Inline'
              )
            },
            {
              value: 'side-by-side',
              label: translate(
                'auto.components.settings.GeneralEditorSettingsSection.12cbc0d0d6',
                'Side-by-side'
              )
            }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.8f1afdfbd8',
          'Diff Word Wrap'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.4aa4d9fb73',
          'Wrap long lines in diff editors instead of requiring horizontal scrolling.'
        )}
        keywords={['diff', 'word wrap', 'wrap', 'markdown', 'long lines']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.8f1afdfbd8',
              'Diff Word Wrap'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.4aa4d9fb73',
              'Wrap long lines in diff editors instead of requiring horizontal scrolling.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel={translate(
            'auto.components.settings.GeneralEditorSettingsSection.8f1afdfbd8',
            'Diff Word Wrap'
          )}
          value={settings.diffWordWrap ? 'on' : 'off'}
          onChange={(option) => updateSettings({ diffWordWrap: option === 'on' })}
          options={[
            {
              value: 'off',
              label: translate(
                'auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2',
                'Off'
              )
            },
            {
              value: 'on',
              label: translate(
                'auto.components.settings.GeneralEditorSettingsSection.3f6892f307',
                'On'
              )
            }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.1de48ad940',
          'Default Diff File Tree'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.1b87897af9',
          'Show or hide the file tree when opening combined diff views.'
        )}
        keywords={['diff', 'tree', 'file tree', 'combined diff', 'sidebar']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.1de48ad940',
              'Default Diff File Tree'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralEditorSettingsSection.1b87897af9',
              'Show or hide the file tree when opening combined diff views.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel={translate(
            'auto.components.settings.GeneralEditorSettingsSection.1de48ad940',
            'Default Diff File Tree'
          )}
          value={settings.combinedDiffFileTreeVisibleByDefault ? 'shown' : 'hidden'}
          onChange={(option) =>
            updateSettings({ combinedDiffFileTreeVisibleByDefault: option === 'shown' })
          }
          options={[
            {
              value: 'shown',
              label: translate(
                'auto.components.settings.GeneralEditorSettingsSection.73a09aad63',
                'Shown'
              )
            },
            {
              value: 'hidden',
              label: translate(
                'auto.components.settings.GeneralEditorSettingsSection.5a1ea6eaa2',
                'Hidden'
              )
            }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.6690b1ffb9',
          'Minimap'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.51161d1647',
          'Show the minimap overview when editing a file.'
        )}
        keywords={['minimap', 'overview', 'code', 'scroll']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.GeneralEditorSettingsSection.6690b1ffb9',
            'Minimap'
          )}
          description={translate(
            'auto.components.settings.GeneralEditorSettingsSection.51161d1647',
            'Show the minimap overview when editing a file.'
          )}
          checked={settings.editorMinimapEnabled}
          onChange={() => updateSettings({ editorMinimapEnabled: !settings.editorMinimapEnabled })}
        />
      </SearchableSetting>

      <RichMarkdownSpellcheckSetting settings={settings} updateSettings={updateSettings} />

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
          'Markdown Review Notes'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.5f02e6fb21',
          'Show local markdown review note controls in rich editor mode.'
        )}
        keywords={['markdown', 'review', 'notes', 'annotations', 'agents']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
            'Markdown Review Notes'
          )}
          description={translate(
            'auto.components.settings.GeneralEditorSettingsSection.f80603d293',
            'Show local markdown note controls in rich editor mode and agent handoff actions.'
          )}
          checked={settings.markdownReviewToolsEnabled}
          onChange={() =>
            updateSettings({ markdownReviewToolsEnabled: !settings.markdownReviewToolsEnabled })
          }
        />
      </SearchableSetting>
    </section>
  )
}
