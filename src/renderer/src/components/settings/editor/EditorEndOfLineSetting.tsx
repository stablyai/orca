import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeEditorEndOfLine,
  type EditorEndOfLine
} from '../../../../../shared/editor/saving/editor-end-of-line'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getEndOfLineSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.editorEndOfLine.title', 'End of line'),
    description: t(
      'settings.editorEndOfLine.description',
      'Line ending for new files and files with no line breaks yet. Auto follows the system that runs the file’s workspace: LF for Linux, macOS, and WSL, CRLF for Windows. Files with line breaks keep theirs.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'settings.editorEndOfLine.keywordLineEnding',
        'line ending',
        { aliases: ['eol', 'lf', 'crlf', 'newline'] },
        t
      )
    ]
  }
}

export function EditorEndOfLineSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getEndOfLineSearchEntry(t)
  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.endOfLine}
      {...entry}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{entry.title}</Label>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      </div>
      <SettingsSegmentedControl<EditorEndOfLine>
        ariaLabel={entry.title}
        value={normalizeEditorEndOfLine(settings.editorEndOfLine)}
        onChange={(editorEndOfLine) => updateSettings({ editorEndOfLine })}
        options={[
          { value: 'auto', label: t('settings.editorEndOfLine.auto', 'Auto') },
          { value: 'lf', label: t('settings.editorEndOfLine.lf', 'LF') },
          { value: 'crlf', label: t('settings.editorEndOfLine.crlf', 'CRLF') }
        ]}
      />
    </SearchableSetting>
  )
}
