import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type EditorInsertFinalNewlineSettingProps = {
  settings: Pick<GlobalSettings, 'editorInsertFinalNewline'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorInsertFinalNewlineSetting({
  settings,
  updateSettings
}: EditorInsertFinalNewlineSettingProps): React.JSX.Element {
  const enabled = settings.editorInsertFinalNewline === true
  const title = translate(
    'components.settings.editor.insertFinalNewline.title',
    'Insert Final Newline'
  )
  const description = translate(
    'components.settings.editor.insertFinalNewline.description',
    'Add a line break at the end of a file when saving it from the code editor.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['newline', 'final newline', 'trailing newline', 'end of file', 'eof', 'save']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={() => updateSettings({ editorInsertFinalNewline: !enabled })}
      />
    </SearchableSetting>
  )
}
