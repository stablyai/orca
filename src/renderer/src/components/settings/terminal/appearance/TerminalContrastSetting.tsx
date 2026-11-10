import { useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { Slider } from '../../../ui/slider'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { LIGHT_BG_MIN_CONTRAST } from '../../../../../../shared/terminal-themes/terminal-contrast-correction'
import {
  MIN_TERMINAL_CONTRAST_RATIO,
  MAX_TERMINAL_CONTRAST_RATIO,
  normalizeTerminalMinimumContrastRatio
} from '../../../../../../shared/terminal-themes/terminal-minimum-contrast-settings'
import { useTranslate } from '@/i18n/use-translate'

type ContrastMode = 'auto' | 'off' | 'custom'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalContrastSetting({ settings, updateSettings }: Props): React.JSX.Element {
  const t = useTranslate()
  const value = normalizeTerminalMinimumContrastRatio(settings.terminalMinimumContrastRatio)
  const mode: ContrastMode = value === undefined ? 'auto' : value === 1 ? 'off' : 'custom'
  const lastCustomValue = useRef(LIGHT_BG_MIN_CONTRAST)
  const [draft, setDraft] = useState(value ?? LIGHT_BG_MIN_CONTRAST)
  const [previousValue, setPreviousValue] = useState(value)
  if (value !== previousValue) {
    setPreviousValue(value)
    setDraft(value ?? LIGHT_BG_MIN_CONTRAST)
  }
  const title = t('auto.components.settings.contrast.aa914efccf', 'Color contrast')
  const description = t(
    'auto.components.settings.contrast.description',
    'Improve text readability or preserve the colors chosen by terminal programs.'
  )
  const ratioLabel = t('auto.components.settings.contrast.ratio', 'Contrast target')
  const selectMode = (next: ContrastMode): void => {
    if (mode === 'custom' && value !== undefined) {
      lastCustomValue.current = value
    }
    updateSettings({
      terminalMinimumContrastRatio:
        next === 'auto' ? undefined : next === 'off' ? 1 : lastCustomValue.current
    })
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'terminal',
        'contrast',
        'minimum',
        'ratio',
        'readability',
        'accessibility',
        'wcag',
        'powerline',
        'statusline',
        'dim',
        'washed out',
        'colors'
      ]}
    >
      <SettingsRow
        label={title}
        description={
          mode === 'auto'
            ? t(
                'auto.components.settings.contrast.autoDescription',
                'Balances readability with your terminal theme. Recommended.'
              )
            : mode === 'off'
              ? t(
                  'auto.components.settings.contrast.offDescription',
                  'Keeps program colors unchanged, including dim text and Powerline separators.'
                )
              : t(
                  'auto.components.settings.contrast.customDescription',
                  'Choose how much to increase contrast between text and its background.'
                )
        }
        className="flex-wrap [&>div:first-child]:min-w-48"
        control={
          <SettingsSegmentedControl<ContrastMode>
            ariaLabel={title}
            value={mode}
            onChange={selectMode}
            options={[
              {
                value: 'auto',
                label: t('auto.components.settings.contrast.auto', 'Automatic')
              },
              { value: 'off', label: t('auto.components.settings.contrast.off', 'Off') },
              {
                value: 'custom',
                label: t('auto.components.settings.contrast.custom', 'Custom')
              }
            ]}
          />
        }
      />
      {mode === 'custom' && (
        <div className="space-y-3 pb-4">
          <NumberField
            label={ratioLabel}
            description={t(
              'auto.components.settings.contrast.targetDescription',
              'Higher values increase contrast where possible. Background colors stay unchanged.'
            )}
            value={draft}
            min={MIN_TERMINAL_CONTRAST_RATIO}
            max={MAX_TERMINAL_CONTRAST_RATIO}
            step={0.1}
            suffix=":1"
            onChange={(ratio) => updateSettings({ terminalMinimumContrastRatio: ratio })}
          />
          <Slider
            value={[draft]}
            min={MIN_TERMINAL_CONTRAST_RATIO + 0.1}
            max={MAX_TERMINAL_CONTRAST_RATIO}
            step={0.1}
            thumbLabels={[ratioLabel]}
            thumbValueLabels={[`${draft}:1`]}
            onValueChange={([ratio]) => setDraft(ratio)}
            onValueCommit={([ratio]) => updateSettings({ terminalMinimumContrastRatio: ratio })}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t('auto.components.settings.contrast.subtle', 'Subtle')}</span>
            <span>{t('auto.components.settings.contrast.strong', 'Strong')}</span>
          </div>
        </div>
      )}
    </SearchableSetting>
  )
}
