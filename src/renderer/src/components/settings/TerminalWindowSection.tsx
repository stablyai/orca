import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { GlobalSettings, TerminalColorOverrides } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { ColorField, NumberField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'

type TerminalWindowSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const COLOR_OVERRIDE_GROUPS: {
  label: string
  keys: { key: keyof TerminalColorOverrides; label: string; description: string }[]
}[] = [
  {
    label: 'Base',
    keys: [
      { key: 'foreground', label: 'Foreground', description: 'Main text color' },
      { key: 'background', label: 'Background', description: 'Terminal background color' },
      { key: 'cursor', label: 'Cursor', description: 'Cursor color' },
      {
        key: 'cursorAccent',
        label: 'Cursor Text',
        description: 'Color of text under the cursor (block cursor)'
      },
      {
        key: 'selectionBackground',
        label: 'Selection Background',
        description: 'Background color of selected text'
      },
      {
        key: 'selectionForeground',
        label: 'Selection Foreground',
        description: 'Text color of selected text'
      },
      {
        key: 'bold',
        label: 'Bold Text',
        description: 'Color for bold text. Falls back to the normal color if not set.'
      }
    ]
  },
  {
    label: 'ANSI Normal',
    keys: [
      { key: 'black', label: 'Black', description: 'ANSI black color' },
      { key: 'red', label: 'Red', description: 'ANSI red color' },
      { key: 'green', label: 'Green', description: 'ANSI green color' },
      { key: 'yellow', label: 'Yellow', description: 'ANSI yellow color' },
      { key: 'blue', label: 'Blue', description: 'ANSI blue color' },
      { key: 'magenta', label: 'Magenta', description: 'ANSI magenta color' },
      { key: 'cyan', label: 'Cyan', description: 'ANSI cyan color' },
      { key: 'white', label: 'White', description: 'ANSI white color' }
    ]
  },
  {
    label: 'ANSI Bright',
    keys: [
      { key: 'brightBlack', label: 'Bright Black', description: 'ANSI bright black color' },
      { key: 'brightRed', label: 'Bright Red', description: 'ANSI bright red color' },
      { key: 'brightGreen', label: 'Bright Green', description: 'ANSI bright green color' },
      { key: 'brightYellow', label: 'Bright Yellow', description: 'ANSI bright yellow color' },
      { key: 'brightBlue', label: 'Bright Blue', description: 'ANSI bright blue color' },
      { key: 'brightMagenta', label: 'Bright Magenta', description: 'ANSI bright magenta color' },
      { key: 'brightCyan', label: 'Bright Cyan', description: 'ANSI bright cyan color' },
      { key: 'brightWhite', label: 'Bright White', description: 'ANSI bright white color' }
    ]
  }
]

export function TerminalWindowSection({
  settings,
  updateSettings
}: TerminalWindowSectionProps): React.JSX.Element {
  const [colorOverridesExpanded, setColorOverridesExpanded] = useState(false)
  // Why: windowBackgroundBlur is only read by createMainWindow() at startup
  // (macOS vibrancy / Windows acrylic both require window creation options),
  // so the UI has to ask the user to restart for the change to take effect.
  // Snapshot the value on first render and compare to the live setting to
  // show a "Restart required" banner only when they differ.
  const blurAtMountRef = useRef<boolean>(settings.windowBackgroundBlur ?? false)
  const blurPendingRestart = (settings.windowBackgroundBlur ?? false) !== blurAtMountRef.current
  const [relaunchingBlur, setRelaunchingBlur] = useState(false)

  // Why: the mount-time snapshot captures local state, not main-process state.
  // If the setting is persisted and read correctly on next boot we never need
  // to re-snapshot, but tests mount the component with arbitrary initial
  // values — keep `blurAtMountRef` honest if the settings load asynchronously
  // and the value arrives after mount.
  useEffect(() => {
    blurAtMountRef.current = settings.windowBackgroundBlur ?? false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleRelaunch = async (): Promise<void> => {
    if (relaunchingBlur) {
      return
    }
    setRelaunchingBlur(true)
    try {
      await window.api.app.relaunch()
    } catch {
      setRelaunchingBlur(false)
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Window</h3>
        <p className="text-xs text-muted-foreground">Window appearance and background settings.</p>
      </div>

      <SearchableSetting
        title="Background Opacity"
        description="Controls the transparency of the terminal background."
        keywords={['opacity', 'transparency', 'background', 'alpha']}
      >
        <NumberField
          label="Background Opacity"
          description="Controls the transparency of the terminal background. 1 is fully opaque, 0 is fully transparent."
          value={settings.terminalBackgroundOpacity ?? 1}
          defaultValue={1}
          min={0}
          max={1}
          step={0.05}
          suffix="0 to 1"
          onChange={(value) =>
            updateSettings({ terminalBackgroundOpacity: clampNumber(value, 0, 1) })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title="Window Blur"
        description="Apply background blur to the terminal window. Requires restart."
        keywords={['window', 'blur', 'background', 'transparency', 'vibrancy']}
        className="space-y-3 px-1 py-2"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>Window Blur</Label>
            <p className="text-xs text-muted-foreground">
              Apply background blur to the terminal window. Requires restart.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.windowBackgroundBlur ?? false}
            onClick={() => updateSettings({ windowBackgroundBlur: !settings.windowBackgroundBlur })}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              (settings.windowBackgroundBlur ?? false) ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                (settings.windowBackgroundBlur ?? false) ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {blurPendingRestart ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
                Restart required
              </p>
              <p className="text-xs text-muted-foreground">
                Restart Orca to apply the window blur change.
              </p>
            </div>
            <Button
              size="sm"
              variant="default"
              className="shrink-0 gap-1.5"
              disabled={relaunchingBlur}
              onClick={() => void handleRelaunch()}
            >
              <RotateCw className={`size-3 ${relaunchingBlur ? 'animate-spin' : ''}`} />
              {relaunchingBlur ? 'Restarting…' : 'Restart now'}
            </Button>
          </div>
        ) : null}
      </SearchableSetting>

      <SearchableSetting
        title="Horizontal Padding"
        description="Horizontal padding around the terminal grid in pixels."
        keywords={['padding', 'horizontal', 'spacing', 'margin']}
      >
        <NumberField
          label="Horizontal Padding"
          description="Horizontal padding around the terminal grid in pixels."
          value={settings.terminalPaddingX ?? 4}
          defaultValue={4}
          min={0}
          max={512}
          step={1}
          suffix="px"
          onChange={(value) => updateSettings({ terminalPaddingX: Math.max(0, value) })}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Vertical Padding"
        description="Vertical padding around the terminal grid in pixels."
        keywords={['padding', 'vertical', 'spacing', 'margin']}
      >
        <NumberField
          label="Vertical Padding"
          description="Vertical padding around the terminal grid in pixels."
          value={settings.terminalPaddingY ?? 4}
          defaultValue={4}
          min={0}
          max={512}
          step={1}
          suffix="px"
          onChange={(value) => updateSettings({ terminalPaddingY: Math.max(0, value) })}
        />
      </SearchableSetting>

      <SearchableSetting
        title="Hide Mouse While Typing"
        description="Hide the mouse cursor when typing in the terminal."
        keywords={['mouse', 'hide', 'typing', 'cursor']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Hide Mouse While Typing</Label>
          <p className="text-xs text-muted-foreground">
            Hide the mouse cursor when typing in the terminal.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.terminalMouseHideWhileTyping ?? false}
          onClick={() =>
            updateSettings({
              terminalMouseHideWhileTyping: !settings.terminalMouseHideWhileTyping
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            (settings.terminalMouseHideWhileTyping ?? false)
              ? 'bg-foreground'
              : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              (settings.terminalMouseHideWhileTyping ?? false) ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>

      <SearchableSetting
        title="Color Overrides"
        description="Override individual terminal colors."
        keywords={['color', 'override', 'ansi', 'palette', 'theme']}
        className="space-y-3"
      >
        <div className="space-y-2">
          <button
            onClick={() => setColorOverridesExpanded((prev) => !prev)}
            className="flex items-center gap-2 text-sm font-medium"
          >
            <span className={`transition-transform ${colorOverridesExpanded ? 'rotate-90' : ''}`}>
              ▶
            </span>
            Color Overrides
          </button>
          <div
            className={`grid overflow-hidden transition-all duration-300 ease-out ${
              colorOverridesExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            }`}
          >
            <div className="min-h-0 space-y-4">
              {COLOR_OVERRIDE_GROUPS.map((group) => (
                <div key={group.label} className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground">{group.label}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.keys.map((item) => (
                      <ColorField
                        key={item.key}
                        label={item.label}
                        description={item.description}
                        value={settings.terminalColorOverrides?.[item.key] ?? ''}
                        fallback=""
                        onChange={(value) =>
                          updateSettings({
                            terminalColorOverrides: {
                              ...settings.terminalColorOverrides,
                              [item.key]: value || undefined
                            }
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => updateSettings({ terminalColorOverrides: undefined })}
              >
                Reset all color overrides
              </Button>
            </div>
          </div>
        </div>
      </SearchableSetting>
    </section>
  )
}
