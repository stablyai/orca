import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { NumberField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_INTERFACE_GLASS_OPACITY,
  DEFAULT_NATIVE_CHAT_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
  normalizeInterfaceGlassOpacity,
  normalizeNativeChatGlassOpacity
} from '../../../../shared/window-glass'
import {
  chatGlassOpacityDescription,
  interfaceGlassDescription,
  interfaceGlassOpacityDescription,
  terminalChatGlassDescription
} from './terminal-window-glass-copy'

/** macOS-only glass tuning: the chat UI and the rest of the interface over the Window Blur backdrop. */
export function MacWindowGlassSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const blurEnabled = settings.windowBackgroundBlur === true
  return (
    <>
      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalWindowSection.chatGlassOpacity',
          'Chat Glass Opacity'
        )}
        description={translate(
          'auto.components.settings.TerminalWindowSection.chatGlassOpacityDescription',
          'macOS: how much of the blurred desktop shows through the chat UI when Window Blur is on.'
        )}
        keywords={['chat', 'glass', 'opacity', 'transparency', 'blur']}
      >
        <NumberField
          label={translate(
            'auto.components.settings.TerminalWindowSection.chatGlassOpacity',
            'Chat Glass Opacity'
          )}
          description={chatGlassOpacityDescription(blurEnabled)}
          value={normalizeNativeChatGlassOpacity(settings.nativeChatGlassOpacity)}
          defaultValue={DEFAULT_NATIVE_CHAT_GLASS_OPACITY}
          min={MIN_GLASS_OPACITY}
          max={1}
          step={0.05}
          suffix={`${MIN_GLASS_OPACITY} to 1`}
          onChange={(value) =>
            updateSettings({ nativeChatGlassOpacity: normalizeNativeChatGlassOpacity(value) })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalWindowSection.terminalChatGlass',
          'Terminals Use Chat Glass'
        )}
        description={translate(
          'auto.components.settings.TerminalWindowSection.terminalChatGlassSummary',
          'macOS: give terminals the chat glass tint and opacity when Window Blur is on.'
        )}
        keywords={['terminal', 'chat', 'glass', 'tint', 'opacity', 'blur', 'contrast']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.TerminalWindowSection.terminalChatGlass',
              'Terminals Use Chat Glass'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {terminalChatGlassDescription(blurEnabled)}
          </p>
        </div>
        <Switch
          aria-label={translate(
            'auto.components.settings.TerminalWindowSection.terminalChatGlass',
            'Terminals Use Chat Glass'
          )}
          checked={settings.terminalChatGlass ?? false}
          onCheckedChange={(checked) => updateSettings({ terminalChatGlass: checked })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalWindowSection.interfaceGlass',
          'Interface Glass'
        )}
        description={translate(
          'auto.components.settings.TerminalWindowSection.interfaceGlassSummary',
          'macOS: extend Window Blur glass to the sidebars, tab bar, status bar, and full pages.'
        )}
        keywords={['interface', 'glass', 'sidebar', 'transparency', 'blur', 'vibrancy']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.TerminalWindowSection.interfaceGlass',
              'Interface Glass'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">{interfaceGlassDescription(blurEnabled)}</p>
        </div>
        <Switch
          aria-label={translate(
            'auto.components.settings.TerminalWindowSection.interfaceGlass',
            'Interface Glass'
          )}
          checked={settings.interfaceGlass ?? false}
          onCheckedChange={(checked) => updateSettings({ interfaceGlass: checked })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalWindowSection.interfaceGlassOpacity',
          'Interface Glass Opacity'
        )}
        description={translate(
          'auto.components.settings.TerminalWindowSection.interfaceGlassOpacityDescription',
          'macOS: how much of the blurred desktop shows through the sidebars, tab bar, status bar, and full pages.'
        )}
        keywords={['interface', 'glass', 'opacity', 'transparency']}
      >
        <NumberField
          label={translate(
            'auto.components.settings.TerminalWindowSection.interfaceGlassOpacity',
            'Interface Glass Opacity'
          )}
          description={interfaceGlassOpacityDescription(
            blurEnabled,
            settings.interfaceGlass === true
          )}
          value={normalizeInterfaceGlassOpacity(settings.interfaceGlassOpacity)}
          defaultValue={DEFAULT_INTERFACE_GLASS_OPACITY}
          min={MIN_GLASS_OPACITY}
          max={1}
          step={0.05}
          suffix={`${MIN_GLASS_OPACITY} to 1`}
          onChange={(value) =>
            updateSettings({ interfaceGlassOpacity: normalizeInterfaceGlassOpacity(value) })
          }
        />
      </SearchableSetting>
    </>
  )
}
