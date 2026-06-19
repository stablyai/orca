import React, { useEffect, useRef } from 'react'
import { Ban, Plus, RotateCcw, Terminal } from 'lucide-react'
import {
  formatKeybinding,
  isDoubleTapBinding,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingInput
} from '../../../../shared/keybindings'
import {
  ModifierDoubleTapDetector,
  modifierFromKeyEvent,
  toModifierDoubleTapEvent
} from '../../../../shared/modifier-double-tap-detector'
import { cn } from '../../lib/utils'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type ShortcutBindingRowProps = {
  item: KeybindingDefinition
  groupTitle: string
  platform: NodeJS.Platform
  effective: readonly string[]
  modified: boolean
  error?: string
  warnings: readonly string[]
  recording: boolean
  terminalStatus?: ShortcutTerminalStatus
  onStartRecording: (actionId: KeybindingActionId) => void
  onCancelRecording: () => void
  onCapture: (actionId: KeybindingActionId, input: KeybindingInput) => void
  onClearError: (actionId: KeybindingActionId) => void
  onDisable: (actionId: KeybindingActionId) => void
  onReset: (actionId: KeybindingActionId) => void
}

export type ShortcutTerminalStatus = {
  label: string
  description: string
}

export function ShortcutBindingRow({
  item,
  groupTitle,
  platform,
  effective,
  modified,
  error,
  warnings,
  recording,
  terminalStatus,
  onStartRecording,
  onCancelRecording,
  onCapture,
  onClearError,
  onDisable,
  onReset
}: ShortcutBindingRowProps): React.JSX.Element {
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
    window.api.ui.setShortcutRecorderFocused(recording)
    return () => window.api.ui.setShortcutRecorderFocused(false)
  }, [recording])

  const statusMessage = error ?? (warnings.length > 0 ? warnings.join(' ') : '')
  const doubleTapHint = platform === 'darwin' ? '⇧⇧' : 'Shift Shift'
  const recordingMessage = recording
    ? translate(
        'auto.components.settings.ShortcutBindingRow.a98d551407',
        'Press a shortcut, or double-tap a modifier (e.g. {{value0}}). Esc cancels.',
        { value0: doubleTapHint }
      )
    : ''
  const helperMessage = statusMessage || recordingMessage
  const hasBinding = effective.length > 0

  const handleRecordKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onStartRecording(item.id)
      }
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      doubleTapDetectorRef.current?.reset()
      onClearError(item.id)
      onCancelRecording()
      return
    }

    // A modifier press never captures on its own — the detector decides whether
    // it completes a double-tap, leaving normal chords to capture on their key.
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
        onClearError(item.id)
        onCapture(item.id, { doubleTapModifier: detected.modifier })
        doubleTapDetectorRef.current?.reset()
      }
      return
    }

    doubleTapDetectorRef.current?.reset()
    onClearError(item.id)
    onCapture(item.id, {
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

  // Why: the recorder is the row's primary control — clicking the keys (or the
  // "Add shortcut" placeholder) records a new binding in place, so the whole
  // affordance lives inline rather than in a detached popover.
  const recorderLabel = recording
    ? `Press shortcut keys for ${item.title}. Escape cancels.`
    : hasBinding
      ? `Change shortcut for ${item.title}`
      : `Add shortcut for ${item.title}`

  return (
    <SearchableSetting
      title={item.title}
      description={translate(
        'auto.components.settings.ShortcutBindingRow.3b11ef3a43',
        '{{value0}} shortcut',
        { value0: groupTitle }
      )}
      keywords={[...item.searchKeywords]}
      className="group/shortcut relative flex min-h-[44px] max-w-none items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40 focus-within:bg-accent/40"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{item.title}</span>
          {modified ? (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {translate('auto.components.settings.ShortcutBindingRow.97dccee14e', 'Modified')}
            </Badge>
          ) : null}
          {terminalStatus ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="shrink-0 gap-1 border-border/70 text-[11px] text-muted-foreground"
                >
                  <Terminal className="size-3" />
                  {terminalStatus.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {terminalStatus.description}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {helperMessage ? (
          <span
            className={cn(
              'block truncate text-[11px] leading-4',
              error ? 'text-destructive' : 'text-muted-foreground'
            )}
            aria-live="polite"
          >
            {helperMessage}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Reset/Disable reveal on hover or keyboard focus to keep the row calm;
            they stay reachable via focus-within for keyboard users. */}
        {hasBinding ? (
          <div className="flex items-center gap-0.5 can-hover:opacity-0 transition-opacity group-hover/shortcut:opacity-100 group-focus-within/shortcut:opacity-100">
            {modified ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.settings.ShortcutBindingRow.4f2c9b2a05',
                      'Reset {{value0}} to default',
                      { value0: item.title }
                    )}
                    onClick={() => onReset(item.id)}
                  >
                    <RotateCcw className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.settings.ShortcutBindingRow.f75335b155',
                    'Reset to default'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={translate(
                    'auto.components.settings.ShortcutBindingRow.3b62c142fa',
                    'Disable {{value0}}',
                    { value0: item.title }
                  )}
                  onClick={() => onDisable(item.id)}
                >
                  <Ban className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.settings.ShortcutBindingRow.9cdaaa3d8f',
                  'Disable shortcut'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={recordButtonRef}
              type="button"
              aria-label={recorderLabel}
              aria-invalid={Boolean(error)}
              aria-pressed={recording}
              data-shortcut-recorder=""
              data-shortcut-recorder-active={recording ? '' : undefined}
              onClick={() => {
                if (!recording) {
                  onStartRecording(item.id)
                }
              }}
              onKeyDown={handleRecordKeyDown}
              onKeyUp={handleRecordKeyUp}
              className={cn(
                'flex min-h-7 min-w-[5.5rem] items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                recording
                  ? 'border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30'
                  : hasBinding
                    ? 'border-transparent hover:border-border/70 hover:bg-background'
                    : 'border-dashed border-border/70 text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              {recording ? (
                <span className="px-1 text-muted-foreground">
                  {translate(
                    'auto.components.settings.ShortcutBindingRow.87381fd8f8',
                    'Press keys…'
                  )}
                </span>
              ) : hasBinding ? (
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  {effective.map((binding) => (
                    <ShortcutKeyCombo
                      key={binding}
                      keys={formatKeybinding(binding, platform)}
                      doubleTap={isDoubleTapBinding(binding)}
                    />
                  ))}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <Plus className="size-3" />
                  {translate(
                    'auto.components.settings.ShortcutBindingRow.4a4c2c9d32',
                    'Add shortcut'
                  )}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {recording
              ? translate(
                  'auto.components.settings.ShortcutBindingRow.6a7848fdac',
                  'Listening for shortcut'
                )
              : hasBinding
                ? translate(
                    'auto.components.settings.ShortcutBindingRow.f6579be67b',
                    'Change shortcut'
                  )
                : translate(
                    'auto.components.settings.ShortcutBindingRow.4a4c2c9d32',
                    'Add shortcut'
                  )}
          </TooltipContent>
        </Tooltip>
      </div>
    </SearchableSetting>
  )
}
