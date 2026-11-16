import React, { useEffect, useEffectEvent, useRef } from 'react'
import { formatKeybinding } from '../../../../../shared/keybindings/formatting'
import { isDoubleTapBinding } from '../../../../../shared/keybindings/normalization'
import type { KeybindingActionId, KeybindingInput } from '../../../../../shared/keybindings/types'
import {
  ModifierDoubleTapDetector,
  modifierFromKeyEvent,
  toModifierDoubleTapEvent
} from '../../../../../shared/keybindings/modifier-double-tap-detector'
import { cn } from '../../../lib/class-names'
import { ShortcutKeyCombo } from '../../ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

type ShortcutRecorderButtonProps = {
  actionId: KeybindingActionId
  title: string
  platform: NodeJS.Platform
  isDigitIndex: boolean
  // The chord this button edits, or null for the transient "add a new binding" slot.
  binding: string | null
  bindingIndex: number
  bindingCount: number
  recording: boolean
  isAppendSlot?: boolean
  /** Menu-row sizing: plain-text keys instead of key caps. */
  compact?: boolean
  onStartRecording: (actionId: KeybindingActionId, index: number) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
}

// Digit-index actions store a representative chord but fire for 1–9; display the full range.
function toDigitRangeKeys(keys: string[]): string[] {
  const last = keys.at(-1)
  if (last === undefined || !/^[1-9]$/.test(last)) {
    return keys
  }
  return [...keys.slice(0, -1), `${last}–9`]
}

export function ShortcutRecorderButton({
  actionId,
  title,
  platform,
  isDigitIndex,
  binding,
  bindingIndex,
  bindingCount,
  recording,
  isAppendSlot = false,
  compact = false,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onClearError
}: ShortcutRecorderButtonProps): React.JSX.Element {
  const t = useTranslate()
  const recordButtonRef = useRef<HTMLButtonElement | null>(null)
  const doubleTapDetectorRef = useRef<ModifierDoubleTapDetector | null>(null)
  if (!doubleTapDetectorRef.current) {
    doubleTapDetectorRef.current = new ModifierDoubleTapDetector()
  }

  useEffect(() => {
    if (recording) {
      recordButtonRef.current?.focus()
    } else {
      // Stale taps mustn't survive into the next recording session.
      doubleTapDetectorRef.current?.reset()
    }
    // ShortcutsPane owns the global recorder-focus flag across rows.
  }, [recording])

  // Leave the row error in place so it can still be read or copied; Esc or the next recording clears it.
  const cancelIfClickedAway = useEffectEvent((): void => {
    if (document.activeElement !== recordButtonRef.current) {
      onCancelRecording()
    }
  })

  // Keys only reach a focused recorder, so a click elsewhere would strand it recording. Cancel on
  // click, not blur: window switches keep recording, and the row only collapses after the click
  // has landed. Capture phase runs before the clicked control's own handler.
  useEffect(() => {
    if (!recording) {
      return
    }
    window.addEventListener('click', cancelIfClickedAway, true)
    return () => window.removeEventListener('click', cancelIfClickedAway, true)
  }, [recording])

  const handleRecordKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onStartRecording(actionId, bindingIndex)
      }
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      doubleTapDetectorRef.current?.reset()
      onClearError(actionId)
      onCancelRecording()
      return
    }

    // Modifiers capture only when the detector completes a double-tap; regular chords wait for their key.
    if (modifierFromKeyEvent(event.code, event.key) !== null) {
      const detected = doubleTapDetectorRef.current?.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: event.code,
          key: event.key,
          shift: event.shiftKey,
          control: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey,
          isAutoRepeat: event.repeat
        }),
        Date.now()
      )
      if (detected) {
        onClearError(actionId)
        onCapture(actionId, { doubleTapModifier: detected.modifier })
        doubleTapDetectorRef.current?.reset()
      }
      return
    }

    doubleTapDetectorRef.current?.reset()
    onClearError(actionId)
    onCapture(actionId, {
      key: event.key,
      code: event.code,
      alt: event.altKey,
      meta: event.metaKey,
      control: event.ctrlKey,
      shift: event.shiftKey
    })
  }

  const handleRecordKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    doubleTapDetectorRef.current?.process(
      toModifierDoubleTapEvent({
        type: 'keyUp',
        code: event.code,
        key: event.key,
        shift: event.shiftKey,
        control: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey
      }),
      Date.now()
    )
  }

  const recorderLabel = recording
    ? t(
        'auto.components.settings.ShortcutRecorderButton.1a13bb054d',
        'Press shortcut keys for {{value0}}. Escape cancels.',
        { value0: title }
      )
    : isAppendSlot || binding === null
      ? t(
          'auto.components.settings.ShortcutRecorderButton.3732775d74',
          'Add shortcut for {{value0}}',
          { value0: title }
        )
      : bindingCount <= 1
        ? t(
            'auto.components.settings.ShortcutRecorderButton.88764af2c1',
            'Change shortcut for {{value0}}',
            { value0: title }
          )
        : t(
            'auto.components.settings.ShortcutRecorderButton.30feb099d6',
            'Change shortcut {{value0}} of {{value1}} for {{value2}}',
            { value0: String(bindingIndex + 1), value1: String(bindingCount), value2: title }
          )

  const tooltipLabel = recording
    ? t('auto.components.settings.ShortcutRecorderButton.5d982a2a1f', 'Listening for shortcut')
    : isAppendSlot || binding === null
      ? t('auto.components.settings.ShortcutRecorderButton.152e0bcd64', 'Add shortcut')
      : t('auto.components.settings.ShortcutRecorderButton.5bd56445da', 'Change shortcut')

  const keys = binding === null ? [] : formatKeybinding(binding, platform)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={recordButtonRef}
          type="button"
          aria-label={recorderLabel}
          aria-pressed={recording}
          data-shortcut-recorder=""
          data-shortcut-recorder-active={recording ? '' : undefined}
          onClick={() => {
            if (!recording) {
              onStartRecording(actionId, bindingIndex)
            }
          }}
          onKeyDown={handleRecordKeyDown}
          onKeyUp={handleRecordKeyUp}
          className={cn(
            'flex items-center justify-end overflow-hidden rounded-md border text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
            compact
              ? 'h-5 min-w-9 shrink-0 px-1.5 text-2xs text-muted-foreground'
              : 'min-h-7 min-w-[5.5rem] max-w-[14rem] gap-1.5 px-2 py-1',
            recording && 'border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30',
            !recording &&
              !compact &&
              'border-transparent hover:border-border/70 hover:bg-background',
            !recording &&
              compact &&
              'border-border/80 hover:border-muted-foreground/60 hover:text-foreground focus-visible:text-foreground',
            !recording && compact && binding === null && 'border-dashed border-border'
          )}
        >
          {recording || binding === null ? (
            <span className={compact ? 'whitespace-nowrap' : 'px-1 text-muted-foreground'}>
              {recording || !compact
                ? t('auto.components.settings.ShortcutRecorderButton.f5ed5dcbf6', 'Press keys…')
                : t('auto.components.settings.ShortcutRecorderButton.152e0bcd64', 'Add shortcut')}
            </span>
          ) : compact ? (
            // Menu-row size: same key combo, drawn as inline glyphs instead of key caps.
            <ShortcutKeyCombo
              keys={keys}
              doubleTap={isDoubleTapBinding(binding)}
              className="gap-0 whitespace-nowrap"
              keyCapClassName="min-w-0 border-0 bg-transparent p-0 text-2xs font-medium text-current shadow-none"
              separatorClassName="text-2xs"
            />
          ) : (
            <span className="flex flex-wrap items-center justify-end gap-1.5 overflow-hidden">
              <ShortcutKeyCombo
                keys={isDigitIndex ? toDigitRangeKeys(keys) : keys}
                doubleTap={isDoubleTapBinding(binding)}
              />
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  )
}
