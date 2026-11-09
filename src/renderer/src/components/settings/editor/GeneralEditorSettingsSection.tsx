import type React from 'react'
import { useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../../shared/constants'
import { clampNumber } from '@/lib/terminal-theme'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { CollapseUnchangedRegionsSetting } from './CollapseUnchangedRegionsSetting'
import { SettingsSegmentedControl, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { RichMarkdownSpellcheckSetting } from './RichMarkdownSpellcheckSetting'
import { MarkdownDefaultViewSetting } from './MarkdownDefaultViewSetting'
import { DiffShowWhitespaceSetting } from './DiffShowWhitespaceSetting'
import { EditorWordWrapSetting } from './EditorWordWrapSetting'
import { EditorFontFamilySetting } from './EditorFontFamilySetting'
import { EditorFormatOnSaveSetting } from './EditorFormatOnSaveSetting'
import { EditorInsertFinalNewlineSetting } from './EditorInsertFinalNewlineSetting'
import { EditorTypographySettings } from './EditorTypographySettings'
import {
  createAutoSaveDelayDraftState,
  resolveAutoSaveDelayDraftState,
  updateAutoSaveDelayDraftState
} from './auto-save-delay-draft'
import { SettingsGroup } from '../section-layout/SettingsGroup'

type GeneralEditorSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  fontSuggestions: string[]
  onRequestFontSuggestions?: () => void
}

export function GeneralEditorSettingsSection({
  settings,
  updateSettings,
  fontSuggestions,
  onRequestFontSuggestions
}: GeneralEditorSettingsSectionProps): React.JSX.Element {
  const t = useTranslate()
  const [autoSaveDelayDraftState, setAutoSaveDelayDraftState] = useState(() =>
    createAutoSaveDelayDraftState(settings.editorAutoSaveDelayMs)
  )

  const resolvedAutoSaveDelayDraftState = resolveAutoSaveDelayDraftState(
    autoSaveDelayDraftState,
    settings.editorAutoSaveDelayMs
  )
  if (resolvedAutoSaveDelayDraftState !== autoSaveDelayDraftState) {
    // Reconcile external settings before paint so drafts cannot lag persisted values.
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
    <SettingsGroup
      key="editor"
      title={t('auto.components.settings.GeneralEditorSettingsSection.45c6e85c4d', 'Editor')}
      description={t(
        'auto.components.settings.GeneralEditorSettingsSection.d21136d9ef',
        'Configure how Orca persists file edits.'
      )}
    >
      <EditorFormatOnSaveSetting settings={settings} updateSettings={updateSettings} />
      <EditorInsertFinalNewlineSetting settings={settings} updateSettings={updateSettings} />

      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralEditorSettingsSection.0df2e4fd12',
          'Auto Save Files'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.70bb30feb1',
          'Save editor and editable diff changes automatically after a short pause.'
        )}
        keywords={['autosave', 'save']}
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.GeneralEditorSettingsSection.0df2e4fd12',
            'Auto Save Files'
          )}
          description={t(
            'auto.components.settings.GeneralEditorSettingsSection.70bb30feb1',
            'Save editor and editable diff changes automatically after a short pause.'
          )}
          checked={settings.editorAutoSave}
          onChange={() => updateSettings({ editorAutoSave: !settings.editorAutoSave })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralEditorSettingsSection.d6cf227ca0',
          'Auto Save Delay'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.1bec6d8318',
          'How long Orca waits after your last edit before saving automatically.'
        )}
        keywords={['autosave', 'delay', 'milliseconds']}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.d6cf227ca0',
              'Auto Save Delay'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.8112cd6dcf',
              'How long Orca waits after your last edit before saving automatically. First launch defaults to'
            )}{' '}
            {DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS}{' '}
            {t('auto.components.settings.GeneralEditorSettingsSection.fc5c5306ff', 'ms.')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            type="number"
            aria-label={t(
              'auto.components.settings.GeneralEditorSettingsSection.d6cf227ca0',
              'Auto Save Delay'
            )}
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
            {t('auto.components.settings.GeneralEditorSettingsSection.a5db1d3975', 'ms')}
          </span>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralEditorSettingsSection.7311f67ee7',
          'Default Diff View'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.b492397d34',
          'Preferred presentation format for showing git diffs by default.'
        )}
        keywords={['diff', 'view', 'inline', 'side-by-side', 'split']}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.7311f67ee7',
              'Default Diff View'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.b492397d34',
              'Preferred presentation format for showing git diffs by default.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel={t(
            'auto.components.settings.GeneralEditorSettingsSection.7311f67ee7',
            'Default Diff View'
          )}
          value={settings.diffDefaultView}
          onChange={(option) => updateSettings({ diffDefaultView: option })}
          options={[
            {
              value: 'inline',
              label: t('auto.components.settings.GeneralEditorSettingsSection.05b6df93b3', 'Inline')
            },
            {
              value: 'side-by-side',
              label: t(
                'auto.components.settings.GeneralEditorSettingsSection.12cbc0d0d6',
                'Side-by-side'
              )
            }
          ]}
        />
      </SearchableSetting>

      <EditorFontFamilySetting
        settings={settings}
        updateSettings={updateSettings}
        fontSuggestions={fontSuggestions}
        onRequestFontSuggestions={onRequestFontSuggestions}
      />

      <EditorTypographySettings settings={settings} updateSettings={updateSettings} />

      <EditorWordWrapSetting settings={settings} updateSettings={updateSettings} />

      <DiffShowWhitespaceSetting settings={settings} updateSettings={updateSettings} />

      <CollapseUnchangedRegionsSetting settings={settings} updateSettings={updateSettings} />

      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralEditorSettingsSection.8f1afdfbd8',
          'Diff Word Wrap'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.4aa4d9fb73',
          'Wrap long lines in diff editors instead of requiring horizontal scrolling.'
        )}
        keywords={['diff', 'word wrap', 'wrap', 'markdown', 'long lines']}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.8f1afdfbd8',
              'Diff Word Wrap'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.4aa4d9fb73',
              'Wrap long lines in diff editors instead of requiring horizontal scrolling.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel={t(
            'auto.components.settings.GeneralEditorSettingsSection.8f1afdfbd8',
            'Diff Word Wrap'
          )}
          value={settings.diffWordWrap ? 'on' : 'off'}
          onChange={(option) => updateSettings({ diffWordWrap: option === 'on' })}
          options={[
            {
              value: 'off',
              label: t('auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2', 'Off')
            },
            {
              value: 'on',
              label: t('auto.components.settings.GeneralEditorSettingsSection.3f6892f307', 'On')
            }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralEditorSettingsSection.1de48ad940',
          'Default Diff File Tree'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.1b87897af9',
          'Show or hide the file tree when opening combined diff views.'
        )}
        keywords={['diff', 'tree', 'file tree', 'combined diff', 'sidebar']}
        className="flex items-center justify-between gap-4 py-3"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.1de48ad940',
              'Default Diff File Tree'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.GeneralEditorSettingsSection.1b87897af9',
              'Show or hide the file tree when opening combined diff views.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          ariaLabel={t(
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
              label: t('auto.components.settings.GeneralEditorSettingsSection.73a09aad63', 'Shown')
            },
            {
              value: 'hidden',
              label: t('auto.components.settings.GeneralEditorSettingsSection.5a1ea6eaa2', 'Hidden')
            }
          ]}
        />
      </SearchableSetting>

      <SearchableSetting
        title={t('auto.components.settings.GeneralEditorSettingsSection.6690b1ffb9', 'Minimap')}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.51161d1647',
          'Show the minimap overview when editing a file.'
        )}
        keywords={['minimap', 'overview', 'code', 'scroll']}
      >
        <SettingsSwitchRow
          label={t('auto.components.settings.GeneralEditorSettingsSection.6690b1ffb9', 'Minimap')}
          description={t(
            'auto.components.settings.GeneralEditorSettingsSection.51161d1647',
            'Show the minimap overview when editing a file.'
          )}
          checked={settings.editorMinimapEnabled}
          onChange={() => updateSettings({ editorMinimapEnabled: !settings.editorMinimapEnabled })}
        />
      </SearchableSetting>

      <MarkdownDefaultViewSetting settings={settings} />

      <RichMarkdownSpellcheckSetting settings={settings} updateSettings={updateSettings} />

      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
          'Markdown Review Notes'
        )}
        description={t(
          'auto.components.settings.GeneralEditorSettingsSection.5f02e6fb21',
          'Show local markdown review note controls in markdown files.'
        )}
        keywords={['markdown', 'review', 'notes', 'annotations', 'agents']}
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
            'Markdown Review Notes'
          )}
          description={t(
            'auto.components.settings.GeneralEditorSettingsSection.f80603d293',
            'Show markdown note controls in every markdown view and include markdown notes in agent handoff actions.'
          )}
          checked={settings.markdownReviewToolsEnabled}
          onChange={() =>
            updateSettings({ markdownReviewToolsEnabled: !settings.markdownReviewToolsEnabled })
          }
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
