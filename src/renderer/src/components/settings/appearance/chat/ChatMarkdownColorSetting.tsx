import { useState } from 'react'
import { X } from 'lucide-react'
import { HEX_COLOR_RE } from '../../../../../../shared/color-validation'
import { translate } from '@/i18n/i18n'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SettingsDisabledControlTooltip } from '../../form-controls/SettingsDisabledControlTooltip'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { chatTerminalControlledHint, chatTerminalControlledTooltip } from './chat-appearance-search'

type ChatMarkdownColorSettingProps = {
  entry: SettingsSearchEntry & { targetSectionId: string; description: string }
  /** Normalized hex, or empty when the theme color applies. */
  value: string
  disabled: boolean
  forceVisible: boolean
  onChange: (value: string | undefined) => void
}

export function ChatMarkdownColorSetting({
  entry,
  value,
  disabled,
  forceVisible,
  onChange
}: ChatMarkdownColorSettingProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(value)
  }
  const commitDraft = (next: string): void => {
    setDraft(next)
    const trimmed = next.trim()
    if (!trimmed) {
      onChange(undefined)
    } else if (HEX_COLOR_RE.test(trimmed)) {
      onChange(trimmed)
    }
  }
  const clearLabel = translate('settings.appearance.chat.useThemeColor', 'Use theme color')

  return (
    <SearchableSetting id={entry.targetSectionId} {...entry} forceVisible={forceVisible}>
      <SettingsRow
        label={entry.title}
        description={disabled ? chatTerminalControlledHint() : entry.description}
        control={
          <SettingsDisabledControlTooltip
            reason={disabled ? chatTerminalControlledTooltip() : undefined}
          >
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={entry.title}
                disabled={disabled}
                value={value || '#ffffff'}
                onChange={(event) => commitDraft(event.target.value)}
                className="h-8 w-10 rounded-md border border-input bg-transparent p-1 disabled:opacity-50"
              />
              <Input
                aria-label={entry.title}
                disabled={disabled}
                value={draft}
                placeholder={translate('settings.appearance.chat.themeColor', 'Theme')}
                onChange={(event) => commitDraft(event.target.value)}
                onBlur={() => setDraft(value)}
                className="w-28"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={clearLabel}
                title={clearLabel}
                disabled={disabled || !value}
                onClick={() => commitDraft('')}
              >
                <X className="size-3" />
              </Button>
            </div>
          </SettingsDisabledControlTooltip>
        }
      />
    </SearchableSetting>
  )
}
