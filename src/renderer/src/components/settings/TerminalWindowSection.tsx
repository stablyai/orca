import { useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { NumberField } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { TerminalColorOverridesSection } from './TerminalColorOverridesSection'
import { clampNumber } from '@/lib/terminal-theme'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type TerminalWindowSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalWindowSection({
  settings,
  updateSettings
}: TerminalWindowSectionProps): React.JSX.Element {
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
        <h3 className="text-sm font-semibold">
          {translate('auto.components.settings.TerminalWindowSection.b96ba13ed1', 'Window')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.TerminalWindowSection.00eaa6b881',
            'Window appearance and background settings.'
          )}
        </p>
      </div>

      <div className="ml-4 space-y-4">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalWindowSection.ea7b1a158e',
            'Background Opacity'
          )}
          description={translate(
            'auto.components.settings.TerminalWindowSection.03acb60aa0',
            'Controls the transparency of the terminal background.'
          )}
          keywords={['opacity', 'transparency', 'background', 'alpha']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalWindowSection.ea7b1a158e',
              'Background Opacity'
            )}
            description={translate(
              'auto.components.settings.TerminalWindowSection.809f37738d',
              'Controls the transparency of the terminal background. 1 is fully opaque, 0 is fully transparent.'
            )}
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
          title={translate(
            'auto.components.settings.TerminalWindowSection.2b82242f43',
            'Window Blur'
          )}
          description={translate(
            'auto.components.settings.TerminalWindowSection.97950bb087',
            'Apply background blur to the terminal window. Requires restart.'
          )}
          keywords={['window', 'blur', 'background', 'transparency', 'vibrancy']}
          className="space-y-3 py-2"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.TerminalWindowSection.2b82242f43',
                  'Window Blur'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.TerminalWindowSection.97950bb087',
                  'Apply background blur to the terminal window. Requires restart.'
                )}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.windowBackgroundBlur ?? false}
              onClick={() =>
                updateSettings({ windowBackgroundBlur: !settings.windowBackgroundBlur })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                (settings.windowBackgroundBlur ?? false)
                  ? 'bg-foreground'
                  : 'bg-muted-foreground/30'
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
                  {translate(
                    'auto.components.settings.TerminalWindowSection.c65bb9ce63',
                    'Restart required'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.TerminalWindowSection.53ce336e15',
                    'Restart Orca to apply the window blur change.'
                  )}
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
                {relaunchingBlur
                  ? translate(
                      'auto.components.settings.TerminalWindowSection.907131d741',
                      'Restarting…'
                    )
                  : translate(
                      'auto.components.settings.TerminalWindowSection.8abdab9f7c',
                      'Restart now'
                    )}
              </Button>
            </div>
          ) : null}
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalWindowSection.36b8402015',
            'Horizontal Padding'
          )}
          description={translate(
            'auto.components.settings.TerminalWindowSection.25e2f8e8e1',
            'Horizontal padding around the terminal grid in pixels.'
          )}
          keywords={['padding', 'horizontal', 'spacing', 'margin']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalWindowSection.36b8402015',
              'Horizontal Padding'
            )}
            description=""
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
          title={translate(
            'auto.components.settings.TerminalWindowSection.1afcc1d973',
            'Vertical Padding'
          )}
          description={translate(
            'auto.components.settings.TerminalWindowSection.1846f6ee6a',
            'Vertical padding around the terminal grid in pixels.'
          )}
          keywords={['padding', 'vertical', 'spacing', 'margin']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalWindowSection.1afcc1d973',
              'Vertical Padding'
            )}
            description=""
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
          title={translate(
            'auto.components.settings.TerminalWindowSection.3530908ef9',
            'Hide Mouse While Typing'
          )}
          description={translate(
            'auto.components.settings.TerminalWindowSection.1d1920dc8a',
            'Hide the mouse cursor when typing in the terminal.'
          )}
          keywords={['mouse', 'hide', 'typing', 'cursor']}
          className="flex items-center justify-between gap-4 py-2"
        >
          <div className="space-y-0.5">
            {/* Why: helper text dropped per copy audit — near-verbatim restatement
              of the label; the search index keeps the longer phrasing. */}
            <Label>
              {translate(
                'auto.components.settings.TerminalWindowSection.3530908ef9',
                'Hide Mouse While Typing'
              )}
            </Label>
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
                (settings.terminalMouseHideWhileTyping ?? false)
                  ? 'translate-x-4'
                  : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        <TerminalColorOverridesSection settings={settings} updateSettings={updateSettings} />
      </div>
    </section>
  )
}
