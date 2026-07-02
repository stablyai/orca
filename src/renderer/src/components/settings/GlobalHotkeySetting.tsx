import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { CircleX } from 'lucide-react'

const isMac = navigator.userAgent.includes('Mac')

const DEFAULT_HOTKEY_ACCELERATOR = 'Alt+Space'

type GlobalHotkeySettingProps = {
  value: string | undefined
  onChange: (accelerator: string) => void
}

/**
 * Parse an Electron accelerator string (e.g. "Alt+Space", "CommandOrControl+K")
 * into an array of display key labels suitable for ShortcutKeyCombo.
 */
function acceleratorToKeys(accelerator: string): string[] {
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
    if (lower === 'space' || lower === 'Space') {
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
function eventToAccelerator(event: React.KeyboardEvent): string | null {
  const parts: string[] = []

  if (event.metaKey) {
    parts.push('CommandOrControl')
  } else if (event.ctrlKey) {
    parts.push('CommandOrControl')
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
  } else if (code.startsWith('F') && /^F\d+$/.test(code)) {
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
  } else if (key.length === 1) {
    keyPart = key.toUpperCase()
  }

  if (!keyPart) {
    return null
  }

  // A valid global hotkey needs at least one modifier.
  if (parts.length === 0) {
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

  const currentAccelerator = value?.trim() ?? ''
  const hasCustom = currentAccelerator !== ''
  const effectiveAccelerator = hasCustom ? currentAccelerator : DEFAULT_HOTKEY_ACCELERATOR

  const displayKeys = acceleratorToKeys(effectiveAccelerator)

  useEffect(() => {
    if (recording) {
      recordButtonRef.current?.focus()
    }
  }, [recording])

  const startRecording = useCallback(() => {
    setRecording(true)
  }, [])

  const cancelRecording = useCallback(() => {
    setRecording(false)
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (!recording) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          startRecording()
        }
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        cancelRecording()
        return
      }

      const accelerator = eventToAccelerator(event)
      if (!accelerator) {
        return
      }

      onChange(accelerator)
      setRecording(false)
    },
    [recording, onChange, startRecording, cancelRecording]
  )

  const clearHotkey = useCallback(() => {
    onChange('')
  }, [onChange])

  const resetToDefault = useCallback(() => {
    onChange(DEFAULT_HOTKEY_ACCELERATOR)
  }, [onChange])

  const recordingLabel = translate(
    'auto.components.settings.GlobalHotkeySetting.recording',
    'Press a key combination (at least one modifier). Escape cancels.'
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          ref={recordButtonRef}
          type="button"
          aria-label={recording ? recordingLabel : undefined}
          aria-pressed={recording}
          onClick={() => {
            if (!recording) {
              startRecording()
            }
          }}
          onKeyDown={handleKeyDown}
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
              {translate('auto.components.settings.GlobalHotkeySetting.disabled', 'Disabled')}
            </span>
          )}
        </button>

        {hasCustom ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearHotkey}
            title={translate(
              'auto.components.settings.GlobalHotkeySetting.disable',
              'Disable global hotkey'
            )}
          >
            <CircleX className="size-4" />
          </Button>
        ) : null}

        {!hasCustom && effectiveAccelerator !== DEFAULT_HOTKEY_ACCELERATOR ? (
          <Button type="button" variant="ghost" size="sm" onClick={resetToDefault}>
            {translate(
              'auto.components.settings.GlobalHotkeySetting.resetDefault',
              'Reset to default'
            )}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.GlobalHotkeySetting.description',
          'Press this key combination anywhere to show or hide the Orca window. Default: {{value0}}+Space',
          { value0: isMac ? '⌥' : 'Alt' }
        )}
      </p>
    </div>
  )
}
