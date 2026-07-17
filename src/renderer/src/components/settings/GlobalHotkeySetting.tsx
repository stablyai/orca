import React, { useCallback, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { SettingsRow } from './SettingsFormControls'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { CircleX } from 'lucide-react'

const isMac = navigator.userAgent.includes('Mac')

type GlobalHotkeySettingProps = {
  value: string | undefined
  onChange: (accelerator: string) => void
}

/**
 * Parse an Electron accelerator string (e.g. "Alt+Space", "Super+K") into an
 * array of display key labels suitable for ShortcutKeyCombo.
 */
export function acceleratorToKeys(accelerator: string): string[] {
  if (!accelerator.trim()) {
    return []
  }
  const parts = accelerator.split('+').map((p) => p.trim())
  return parts.map((part) => {
    const lower = part.toLowerCase()
    if (lower === 'command' || lower === 'cmd' || lower === 'meta' || lower === 'super') {
      return isMac ? '⌘' : 'Win'
    }
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      return isMac ? '⌘' : 'Ctrl'
    }
    if (lower === 'control' || lower === 'ctrl') {
      return isMac ? '⌃' : 'Ctrl'
    }
    if (lower === 'alt' || lower === 'option') {
      return isMac ? '⌥' : 'Alt'
    }
    if (lower === 'shift') {
      return isMac ? '⇧' : 'Shift'
    }
    if (lower === 'space') {
      return 'Space'
    }
    if (lower.length === 1) {
      return lower.toUpperCase()
    }
    // F-keys, Enter, Escape, etc.
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
  })
}

/**
 * Convert a keyboard event into an Electron accelerator string.
 * Returns null if the event does not represent a valid hotkey chord.
 */
export function eventToAccelerator(event: {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  key: string
  code: string
}): string | null {
  const parts: string[] = []

  // Why: keep the platform-primary modifier first while preserving the other
  // physical modifier as a distinct chord instead of aliasing both to CmdOrCtrl.
  if (isMac) {
    if (event.metaKey) {
      parts.push('Super')
    }
    if (event.ctrlKey) {
      parts.push('Control')
    }
  } else {
    if (event.ctrlKey) {
      parts.push('Control')
    }
    if (event.metaKey) {
      parts.push('Super')
    }
  }
  if (event.altKey) {
    parts.push('Alt')
  }
  if (event.shiftKey) {
    parts.push('Shift')
  }

  const key = event.key
  const code = event.code

  // Ignore pure modifier presses.
  if (key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'OS') {
    return null
  }

  // Map common keys to Electron accelerator names.
  let keyPart: string | null = null
  if (code === 'Space' || key === ' ') {
    keyPart = 'Space'
  } else if (code.startsWith('Key')) {
    keyPart = code.slice(3) // e.g. "KeyA" -> "A"
  } else if (code.startsWith('Digit')) {
    keyPart = code.slice(5) // e.g. "Digit1" -> "1"
  } else if (/^F\d+$/.test(code)) {
    keyPart = code // F1-F24
  } else if (key === 'Enter' || key === 'Return') {
    keyPart = 'Enter'
  } else if (key === 'Escape' || key === 'Esc') {
    keyPart = 'Escape'
  } else if (key === 'Tab') {
    keyPart = 'Tab'
  } else if (key === 'Backspace') {
    keyPart = 'Backspace'
  } else if (key === 'Delete') {
    keyPart = 'Delete'
  } else if (key === 'ArrowUp') {
    keyPart = 'Up'
  } else if (key === 'ArrowDown') {
    keyPart = 'Down'
  } else if (key === 'ArrowLeft') {
    keyPart = 'Left'
  } else if (key === 'ArrowRight') {
    keyPart = 'Right'
  } else if (key === '+') {
    // Why: "+" is the accelerator separator, so Electron requires the literal "Plus".
    keyPart = 'Plus'
  } else if (key.length === 1 && key.charCodeAt(0) <= 0x7f) {
    // Why: only single ASCII characters are valid accelerator key codes. A
    // non-ASCII key or a multi-char uppercase (e.g. "ß" -> "SS") would make
    // Electron reject the accelerator and silently drop the previous binding.
    keyPart = key.toUpperCase()
  }

  if (!keyPart) {
    return null
  }

  // Why: Shift alone is never a sufficient modifier for a system-wide chord.
  // Every Shift+<key> combo collides with ordinary Shift usage — capitals and
  // symbols (Shift+A, Shift+1), Shift+Enter soft-newlines, Shift+Tab, and
  // Shift+Arrow selection — so a global grab would swallow it in every app.
  // Require at least one of Control, Alt, or Super/Command.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    return null
  }

  parts.push(keyPart)
  return parts.join('+')
}

export function GlobalHotkeySetting({
  value,
  onChange
}: GlobalHotkeySettingProps): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const recordButtonRef = useRef<HTMLButtonElement | null>(null)

  // Empty or unset means the hotkey is disabled (the feature is opt-in).
  const accelerator = value?.trim() ?? ''
  const displayKeys = acceleratorToKeys(accelerator)

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (!recording) {
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(false)
        return
      }

      const next = eventToAccelerator(event)
      if (!next) {
        return
      }

      onChange(next)
      setRecording(false)
    },
    [recording, onChange]
  )

  // Why: Shift alone is rejected (see eventToAccelerator), so name the accepted
  // modifiers per platform instead of the misleading "any modifier".
  const modifierHint = isMac ? '⌘, Ctrl, or Option' : 'Ctrl, Alt, or Win'
  const recordingLabel = translate(
    'auto.components.settings.GlobalHotkeySetting.recording',
    'Press a key combination that includes {{value0}}. Escape cancels.',
    { value0: modifierHint }
  )

  return (
    <SettingsRow
      label={translate('auto.components.settings.GlobalHotkeySetting.label', 'Global hotkey')}
      description={
        recording
          ? recordingLabel
          : translate(
              'auto.components.settings.GlobalHotkeySetting.description',
              'Press this key combination anywhere to show or hide the Orca window.'
            )
      }
      control={
        <div className="flex items-center gap-2">
          <button
            ref={recordButtonRef}
            type="button"
            aria-label={recording ? recordingLabel : undefined}
            aria-pressed={recording}
            onClick={() => {
              setRecording(true)
              // Why: recording listens on this button's keydown, so it must own
              // focus even when the click did not focus it.
              recordButtonRef.current?.focus()
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => setRecording(false)}
            className={cn(
              'flex min-h-8 min-w-[8rem] items-center justify-center gap-1 rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              recording
                ? 'border-ring bg-accent text-accent-foreground ring-[3px] ring-ring/30'
                : 'border-border/70 bg-background hover:bg-accent/50'
            )}
          >
            {recording ? (
              <span className="text-xs text-muted-foreground">
                {translate('auto.components.settings.GlobalHotkeySetting.pressKeys', 'Press keys…')}
              </span>
            ) : displayKeys.length > 0 ? (
              <ShortcutKeyCombo keys={displayKeys} />
            ) : (
              <span className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.GlobalHotkeySetting.clickToRecord',
                  'Click to record'
                )}
              </span>
            )}
          </button>

          {accelerator !== '' && !recording ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange('')}
              title={translate(
                'auto.components.settings.GlobalHotkeySetting.disable',
                'Disable global hotkey'
              )}
            >
              <CircleX className="size-4" />
            </Button>
          ) : null}
        </div>
      }
    />
  )
}
