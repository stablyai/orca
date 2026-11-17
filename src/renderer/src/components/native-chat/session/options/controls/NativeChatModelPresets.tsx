import { useEffect, useId, useState } from 'react'
import { Option } from 'lucide-react'
import { Toggle, toggleVariants } from '@/components/ui/toggle'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { nativeChatSessionChoiceLabel } from '../../../../../../../shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import {
  MODEL_PRESET_SLOTS,
  sameNativeChatModelPreset,
  type ModelPresetSlot,
  type NativeChatModelPreset
} from './native-chat-model-presets'

export function NativeChatModelPresets(props: {
  presets: readonly (NativeChatModelPreset | null)[]
  currentPreset: NativeChatModelPreset | null
  busy: boolean
  onApply: (slot: ModelPresetSlot) => void
  onSave: (slot: ModelPresetSlot) => void
  onClear: (slot: ModelPresetSlot) => void
}): React.JSX.Element {
  const t = useTranslate()
  const labelId = useId()
  const isMac = getShortcutPlatform() === 'darwin'
  const [assigning, setAssigning] = useState(false)
  useEffect(() => {
    const update = (event: KeyboardEvent) => setAssigning(isMac ? event.altKey : event.ctrlKey)
    const reset = () => setAssigning(false)
    addAppKeyListener('keydown', update, { first: true })
    addAppKeyListener('keyup', update, { first: true })
    window.addEventListener('blur', reset)
    return () => {
      removeAppKeyListener('keydown', update)
      removeAppKeyListener('keyup', update)
      window.removeEventListener('blur', reset)
    }
  }, [isMac])
  return (
    <div
      className="flex min-h-7 items-center justify-between gap-3 px-3 pb-1 text-xs text-muted-foreground"
      onPointerMove={(event) => setAssigning(isMac ? event.altKey : event.ctrlKey)}
    >
      <span id={labelId}>
        {assigning
          ? t('components.native-chat.modelPresets.assignTitle', 'Set preset')
          : t('components.native-chat.modelPresets.title', 'Quick presets')}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex items-center gap-1">
        <span
          aria-hidden="true"
          data-state={assigning ? 'on' : 'off'}
          className={toggleVariants({ variant: 'segmented', size: 'xs' })}
        >
          {isMac ? (
            <Option className="size-3.5" />
          ) : (
            t('components.native-chat.modelPresets.ctrl', 'Ctrl')
          )}
        </span>
        {MODEL_PRESET_SLOTS.map((slot) => {
          const preset = props.presets[slot - 1]
          const current = sameNativeChatModelPreset(preset, props.currentPreset)
          const effortLabel = preset?.effort
            ? nativeChatSessionChoiceLabel(
                { value: preset.effort, label: preset.effortLabel ?? preset.effort },
                say,
                'effort'
              )
            : null
          return (
            <ContextMenu key={slot}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ContextMenuTrigger asChild>
                    <span className="inline-flex">
                      <Toggle
                        variant="chip"
                        size="xs"
                        pressed={current}
                        data-pressed={current}
                        disabled={props.busy || (!props.currentPreset && !preset)}
                        aria-label={t('components.native-chat.modelPresets.slot', 'Slot {{slot}}', {
                          slot
                        })}
                        onClick={(event) => {
                          if (isMac ? event.altKey : event.ctrlKey) {
                            if (props.currentPreset) {
                              props.onSave(slot)
                            }
                          } else if (!current) {
                            props.onApply(slot)
                          }
                        }}
                      >
                        {slot}
                      </Toggle>
                    </span>
                  </ContextMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {preset ? (
                    <div>
                      {preset.modelLabel}
                      {effortLabel ? ` · ${effortLabel}` : ''}
                      {preset.speed
                        ? ` · ${
                            preset.speed.id === 'serviceTier'
                              ? nativeChatSessionChoiceLabel(
                                  { value: preset.speed.value, label: preset.speed.label },
                                  say,
                                  'serviceTier'
                                )
                              : preset.speed.value
                                ? t('components.native-chat.modelPresets.fastOn', 'Fast on')
                                : t('components.native-chat.modelPresets.fastOff', 'Fast off')
                          }`
                        : ''}
                    </div>
                  ) : null}
                  <div>
                    {assigning
                      ? t(
                          'components.native-chat.modelPresets.saveSlot',
                          'Save current settings as preset {{slot}}',
                          { slot }
                        )
                      : preset
                        ? t(
                            'components.native-chat.modelPresets.applySlot',
                            'Use preset {{slot}}',
                            {
                              slot
                            }
                          )
                        : t('components.native-chat.modelPresets.empty', 'Not configured')}
                  </div>
                  <div>
                    {isMac
                      ? t(
                          'components.native-chat.modelPresets.editHintMac',
                          'Hold Option and click to save'
                        )
                      : t(
                          'components.native-chat.modelPresets.editHintCtrl',
                          'Hold Ctrl and click to save'
                        )}
                  </div>
                </TooltipContent>
              </Tooltip>
              <ContextMenuContent density="compact">
                <ContextMenuItem
                  disabled={props.busy || !props.currentPreset}
                  onSelect={() => props.onSave(slot)}
                  aria-label={t(
                    'components.native-chat.modelPresets.saveSlot',
                    'Save current settings as preset {{slot}}',
                    { slot }
                  )}
                >
                  {t('components.native-chat.modelPresets.save', 'Use current settings')}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={props.busy || !preset}
                  onSelect={() => props.onClear(slot)}
                  aria-label={t(
                    'components.native-chat.modelPresets.clearSlot',
                    'Clear preset {{slot}}',
                    { slot }
                  )}
                >
                  {t('components.native-chat.modelPresets.clear', 'Clear')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
      </div>
    </div>
  )
}
