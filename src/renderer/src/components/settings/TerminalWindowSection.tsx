import { useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { GlobalSettings, TerminalColorOverrides } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { ColorField, NumberField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type TerminalWindowSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const COLOR_OVERRIDE_GROUPS: {
  label: string
  keys: { key: keyof TerminalColorOverrides; label: string; description: string }[]
}[] = [
  {
    label: translate("auto.components.settings.TerminalWindowSection.cf37ff69f6", "Base"),
    keys: [
      { key: 'foreground', label: translate("auto.components.settings.TerminalWindowSection.79f6bfb76e", "Foreground"), description: translate("auto.components.settings.TerminalWindowSection.026a0b8013", "Main text color") },
      { key: 'background', label: translate("auto.components.settings.TerminalWindowSection.cc1b2ffeb2", "Background"), description: translate("auto.components.settings.TerminalWindowSection.da64e8f4c1", "Terminal background color") },
      { key: 'cursor', label: translate("auto.components.settings.TerminalWindowSection.c9e1fdf42f", "Cursor"), description: translate("auto.components.settings.TerminalWindowSection.cd0700762b", "Cursor color") },
      {
        key: 'cursorAccent',
        label: translate("auto.components.settings.TerminalWindowSection.a2d9f095a7", "Cursor Text"),
        description: translate("auto.components.settings.TerminalWindowSection.7f4063076c", "Color of text under the cursor (block cursor)")
      },
      {
        key: 'selectionBackground',
        label: translate("auto.components.settings.TerminalWindowSection.40c3cfd30a", "Selection Background"),
        description: translate("auto.components.settings.TerminalWindowSection.74d8555f85", "Background color of selected text")
      },
      {
        key: 'selectionForeground',
        label: translate("auto.components.settings.TerminalWindowSection.8b450b5305", "Selection Foreground"),
        description: translate("auto.components.settings.TerminalWindowSection.b2c0857c49", "Text color of selected text")
      },
      {
        key: 'bold',
        label: translate("auto.components.settings.TerminalWindowSection.862e463f7f", "Bold Text"),
        description: translate("auto.components.settings.TerminalWindowSection.fb8c6f1967", "Color for bold text. Falls back to the normal color if not set.")
      }
    ]
  },
  {
    label: translate("auto.components.settings.TerminalWindowSection.68e9f07de0", "ANSI Normal"),
    keys: [
      { key: 'black', label: translate("auto.components.settings.TerminalWindowSection.adfdee23cb", "Black"), description: translate("auto.components.settings.TerminalWindowSection.cf4437a2f7", "ANSI black color") },
      { key: 'red', label: translate("auto.components.settings.TerminalWindowSection.3a78f30b50", "Red"), description: translate("auto.components.settings.TerminalWindowSection.b41270f5ca", "ANSI red color") },
      { key: 'green', label: translate("auto.components.settings.TerminalWindowSection.8f2092b315", "Green"), description: translate("auto.components.settings.TerminalWindowSection.8a673d4206", "ANSI green color") },
      { key: 'yellow', label: translate("auto.components.settings.TerminalWindowSection.bb516de873", "Yellow"), description: translate("auto.components.settings.TerminalWindowSection.09c1c6b096", "ANSI yellow color") },
      { key: 'blue', label: translate("auto.components.settings.TerminalWindowSection.292a4c7316", "Blue"), description: translate("auto.components.settings.TerminalWindowSection.9635a71c51", "ANSI blue color") },
      { key: 'magenta', label: translate("auto.components.settings.TerminalWindowSection.d5e92fcd94", "Magenta"), description: translate("auto.components.settings.TerminalWindowSection.1705318506", "ANSI magenta color") },
      { key: 'cyan', label: translate("auto.components.settings.TerminalWindowSection.fb8bb4eb1f", "Cyan"), description: translate("auto.components.settings.TerminalWindowSection.bd4c759327", "ANSI cyan color") },
      { key: 'white', label: translate("auto.components.settings.TerminalWindowSection.0cb4459fb8", "White"), description: translate("auto.components.settings.TerminalWindowSection.28846b1ca6", "ANSI white color") }
    ]
  },
  {
    label: translate("auto.components.settings.TerminalWindowSection.1be593d3e8", "ANSI Bright"),
    keys: [
      { key: 'brightBlack', label: translate("auto.components.settings.TerminalWindowSection.260d69ce9a", "Bright Black"), description: translate("auto.components.settings.TerminalWindowSection.f30c492769", "ANSI bright black color") },
      { key: 'brightRed', label: translate("auto.components.settings.TerminalWindowSection.32b1b6acd7", "Bright Red"), description: translate("auto.components.settings.TerminalWindowSection.667de68863", "ANSI bright red color") },
      { key: 'brightGreen', label: translate("auto.components.settings.TerminalWindowSection.7dafd57730", "Bright Green"), description: translate("auto.components.settings.TerminalWindowSection.0ffb02f921", "ANSI bright green color") },
      { key: 'brightYellow', label: translate("auto.components.settings.TerminalWindowSection.936a326be3", "Bright Yellow"), description: translate("auto.components.settings.TerminalWindowSection.e2ef5f4ab7", "ANSI bright yellow color") },
      { key: 'brightBlue', label: translate("auto.components.settings.TerminalWindowSection.66820332fa", "Bright Blue"), description: translate("auto.components.settings.TerminalWindowSection.bef6c0f6bf", "ANSI bright blue color") },
      { key: 'brightMagenta', label: translate("auto.components.settings.TerminalWindowSection.e56e7d6ea0", "Bright Magenta"), description: translate("auto.components.settings.TerminalWindowSection.fe4d89ef85", "ANSI bright magenta color") },
      { key: 'brightCyan', label: translate("auto.components.settings.TerminalWindowSection.f94adc4113", "Bright Cyan"), description: translate("auto.components.settings.TerminalWindowSection.1601140f03", "ANSI bright cyan color") },
      { key: 'brightWhite', label: translate("auto.components.settings.TerminalWindowSection.16948119cb", "Bright White"), description: translate("auto.components.settings.TerminalWindowSection.42e01a6055", "ANSI bright white color") }
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
  const mountedRef = useMountedRef()

  const handleRelaunch = async (): Promise<void> => {
    if (relaunchingBlur) {
      return
    }
    setRelaunchingBlur(true)
    try {
      await window.api.app.relaunch()
    } catch {
      if (mountedRef.current) {
        setRelaunchingBlur(false)
      }
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{translate("auto.components.settings.TerminalWindowSection.b96ba13ed1", "Window")}</h3>
        <p className="text-xs text-muted-foreground">{translate("auto.components.settings.TerminalWindowSection.00eaa6b881", "Window appearance and background settings.")}</p>
      </div>

      <SearchableSetting
        title={translate("auto.components.settings.TerminalWindowSection.ea7b1a158e", "Background Opacity")}
        description={translate("auto.components.settings.TerminalWindowSection.03acb60aa0", "Controls the transparency of the terminal background.")}
        keywords={['opacity', 'transparency', 'background', 'alpha']}
      >
        <NumberField
          label={translate("auto.components.settings.TerminalWindowSection.ea7b1a158e", "Background Opacity")}
          description={translate("auto.components.settings.TerminalWindowSection.809f37738d", "Controls the transparency of the terminal background. 1 is fully opaque, 0 is fully transparent.")}
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
        title={translate("auto.components.settings.TerminalWindowSection.2b82242f43", "Window Blur")}
        description={translate("auto.components.settings.TerminalWindowSection.97950bb087", "Apply background blur to the terminal window. Requires restart.")}
        keywords={['window', 'blur', 'background', 'transparency', 'vibrancy']}
        className="space-y-3 py-2"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{translate("auto.components.settings.TerminalWindowSection.2b82242f43", "Window Blur")}</Label>
            <p className="text-xs text-muted-foreground">
              {translate("auto.components.settings.TerminalWindowSection.97950bb087", "Apply background blur to the terminal window. Requires restart.")}</p>
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
                {translate("auto.components.settings.TerminalWindowSection.c65bb9ce63", "Restart required")}</p>
              <p className="text-xs text-muted-foreground">
                {translate("auto.components.settings.TerminalWindowSection.53ce336e15", "Restart Orca to apply the window blur change.")}</p>
            </div>
            <Button
              size="sm"
              variant="default"
              className="shrink-0 gap-1.5"
              disabled={relaunchingBlur}
              onClick={() => void handleRelaunch()}
            >
              <RotateCw className={`size-3 ${relaunchingBlur ? 'animate-spin' : ''}`} />
              {relaunchingBlur ? translate("auto.components.settings.TerminalWindowSection.907131d741", "Restarting…") : translate("auto.components.settings.TerminalWindowSection.8abdab9f7c", "Restart now")}
            </Button>
          </div>
        ) : null}
      </SearchableSetting>

      <SearchableSetting
        title={translate("auto.components.settings.TerminalWindowSection.36b8402015", "Horizontal Padding")}
        description={translate("auto.components.settings.TerminalWindowSection.25e2f8e8e1", "Horizontal padding around the terminal grid in pixels.")}
        keywords={['padding', 'horizontal', 'spacing', 'margin']}
      >
        <NumberField
          label={translate("auto.components.settings.TerminalWindowSection.36b8402015", "Horizontal Padding")}
          description={translate("auto.components.settings.TerminalWindowSection.25e2f8e8e1", "Horizontal padding around the terminal grid in pixels.")}
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
        title={translate("auto.components.settings.TerminalWindowSection.1afcc1d973", "Vertical Padding")}
        description={translate("auto.components.settings.TerminalWindowSection.1846f6ee6a", "Vertical padding around the terminal grid in pixels.")}
        keywords={['padding', 'vertical', 'spacing', 'margin']}
      >
        <NumberField
          label={translate("auto.components.settings.TerminalWindowSection.1afcc1d973", "Vertical Padding")}
          description={translate("auto.components.settings.TerminalWindowSection.1846f6ee6a", "Vertical padding around the terminal grid in pixels.")}
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
        title={translate("auto.components.settings.TerminalWindowSection.3530908ef9", "Hide Mouse While Typing")}
        description={translate("auto.components.settings.TerminalWindowSection.1d1920dc8a", "Hide the mouse cursor when typing in the terminal.")}
        keywords={['mouse', 'hide', 'typing', 'cursor']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>{translate("auto.components.settings.TerminalWindowSection.3530908ef9", "Hide Mouse While Typing")}</Label>
          <p className="text-xs text-muted-foreground">
            {translate("auto.components.settings.TerminalWindowSection.1d1920dc8a", "Hide the mouse cursor when typing in the terminal.")}</p>
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
        title={translate("auto.components.settings.TerminalWindowSection.63f8d9336e", "Color Overrides")}
        description={translate("auto.components.settings.TerminalWindowSection.e86e09b5c7", "Override individual terminal colors.")}
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
            {translate("auto.components.settings.TerminalWindowSection.63f8d9336e", "Color Overrides")}</button>
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
                {translate("auto.components.settings.TerminalWindowSection.03c855d15f", "Reset all color overrides")}</Button>
            </div>
          </div>
        </div>
      </SearchableSetting>
    </section>
  )
}
