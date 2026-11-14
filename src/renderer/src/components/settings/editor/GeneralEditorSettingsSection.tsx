import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import { useState } from 'react'
import type React from 'react'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../../shared/constants'
import { clampNumber } from '@/lib/terminal/appearance/terminal-theme'
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
import { EditorGitChangeGutterSetting } from './EditorGitChangeGutterSetting'
import { EditorTypographySettings } from './EditorTypographySettings'
import {
  createAutoSaveDelayDraftState,
  resolveAutoSaveDelayDraftState,
  updateAutoSaveDelayDraftState
} from './auto-save-delay-draft'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'

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
    <div
      id="general-editor-settings"
      data-settings-section="general-editor-settings"
      className="space-y-6"
    >
      <SettingsGroup title={t('settings.general.editorGroups.saving', 'Saving')}>
        <EditorFormatOnSaveSetting settings={settings} updateSettings={updateSettings} />
        <EditorInsertFinalNewlineSetting settings={settings} updateSettings={updateSettings} />
        <SearchableSetting
          id={GENERAL_SETTING_ANCHORS.autoSaveDelay}
          title={t(
            'auto.components.settings.GeneralEditorSettingsSection.89ba15b474',
            'Auto save delay'
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
                'auto.components.settings.GeneralEditorSettingsSection.89ba15b474',
                'Auto save delay'
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
                'auto.components.settings.GeneralEditorSettingsSection.89ba15b474',
                'Auto save delay'
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
      </SettingsGroup>
      <SettingsGroup title={t('settings.general.editorGroups.editor', 'Editor')}>
        <EditorFontFamilySetting
          settings={settings}
          updateSettings={updateSettings}
          fontSuggestions={fontSuggestions}
          onRequestFontSuggestions={onRequestFontSuggestions}
        />
        <EditorTypographySettings settings={settings} updateSettings={updateSettings} />
        <EditorWordWrapSetting settings={settings} updateSettings={updateSettings} />
        <SearchableSetting
          id={GENERAL_SETTING_ANCHORS.minimap}
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
            onChange={() =>
              updateSettings({ editorMinimapEnabled: !settings.editorMinimapEnabled })
            }
          />
        </SearchableSetting>
        <EditorGitChangeGutterSetting settings={settings} updateSettings={updateSettings} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.general.editorGroups.diffs', 'Diffs')}>
        <SearchableSetting
          id={GENERAL_SETTING_ANCHORS.diffView}
          title={t(
            'auto.components.settings.GeneralEditorSettingsSection.b11d620d45',
            'Default diff view'
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
                'auto.components.settings.GeneralEditorSettingsSection.b11d620d45',
                'Default diff view'
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
              'auto.components.settings.GeneralEditorSettingsSection.b11d620d45',
              'Default diff view'
            )}
            value={settings.diffDefaultView}
            onChange={(option) => updateSettings({ diffDefaultView: option })}
            options={[
              {
                value: 'inline',
                label: t(
                  'auto.components.settings.GeneralEditorSettingsSection.05b6df93b3',
                  'Inline'
                )
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
        <DiffShowWhitespaceSetting settings={settings} updateSettings={updateSettings} />
        <CollapseUnchangedRegionsSetting settings={settings} updateSettings={updateSettings} />
        <SearchableSetting
          id={GENERAL_SETTING_ANCHORS.diffWrap}
          title={t(
            'auto.components.settings.GeneralEditorSettingsSection.6f33c2a32f',
            'Diff word wrap'
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
                'auto.components.settings.GeneralEditorSettingsSection.6f33c2a32f',
                'Diff word wrap'
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
              'auto.components.settings.GeneralEditorSettingsSection.6f33c2a32f',
              'Diff word wrap'
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
          id={GENERAL_SETTING_ANCHORS.diffTree}
          title={t(
            'auto.components.settings.GeneralEditorSettingsSection.3f63d16992',
            'Default diff file tree'
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
                'auto.components.settings.GeneralEditorSettingsSection.3f63d16992',
                'Default diff file tree'
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
              'auto.components.settings.GeneralEditorSettingsSection.3f63d16992',
              'Default diff file tree'
            )}
            value={settings.combinedDiffFileTreeVisibleByDefault ? 'shown' : 'hidden'}
            onChange={(option) =>
              updateSettings({ combinedDiffFileTreeVisibleByDefault: option === 'shown' })
            }
            options={[
              {
                value: 'shown',
                label: t(
                  'auto.components.settings.GeneralEditorSettingsSection.73a09aad63',
                  'Shown'
                )
              },
              {
                value: 'hidden',
                label: t(
                  'auto.components.settings.GeneralEditorSettingsSection.5a1ea6eaa2',
                  'Hidden'
                )
              }
            ]}
          />
        </SearchableSetting>
      </SettingsGroup>
      <SettingsGroup title={t('settings.general.editorGroups.markdown', 'Markdown')}>
        <MarkdownDefaultViewSetting settings={settings} />
        <RichMarkdownSpellcheckSetting settings={settings} updateSettings={updateSettings} />
        <SearchableSetting
          id={GENERAL_SETTING_ANCHORS.reviewNotes}
          title={t(
            'auto.components.settings.GeneralEditorSettingsSection.8b3f8e6b83',
            'Markdown review notes'
          )}
          description={t(
            'auto.components.settings.GeneralEditorSettingsSection.5f02e6fb21',
            'Show local markdown review note controls in markdown files.'
          )}
          keywords={['markdown', 'review', 'notes', 'annotations', 'agents']}
        >
          <SettingsSwitchRow
            label={t(
              'auto.components.settings.GeneralEditorSettingsSection.8b3f8e6b83',
              'Markdown review notes'
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
    </div>
  )
}
