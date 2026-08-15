import type { PortableSettingsCategory } from '../../../../shared/portable-settings'
import { translate } from '@/i18n/i18n'

export function getRuntimeSettingsSyncCategoryCopy(category: PortableSettingsCategory): {
  title: string
  description: string
} {
  switch (category) {
    case 'appearance':
      return {
        title: translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.appearance',
          'Appearance'
        ),
        description: translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.appearanceHelp',
          'Theme, fonts, terminal visuals, diff layout, and sidebar presentation.'
        )
      }
    case 'input':
      return {
        title: translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.input',
          'Input and shortcuts'
        ),
        description: translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.inputHelp',
          'Keyboard shortcuts, editor behavior, terminal scrolling, mouse, and paste preferences.'
        )
      }
    case 'workflow':
      return {
        title: translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.workflow',
          'Agents and workflow'
        ),
        description: translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.workflowHelp',
          'Agent defaults, Git behavior, task views, prompt cache, and tab preferences.'
        )
      }
  }
}
