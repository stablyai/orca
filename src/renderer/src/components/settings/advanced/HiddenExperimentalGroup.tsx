import { useState } from 'react'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import {
  isTerminalRenderDesyncSentinelArmed,
  setTerminalRenderDesyncSentinelArmed
} from '../../terminal-pane/render-health/terminal-render-desync-trigger'
import { useTranslate } from '@/i18n/use-translate'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'

// Warning tokens distinguish unfinished controls across themes.
export function HiddenExperimentalGroup(): React.JSX.Element {
  const t = useTranslate()
  const isMac = getShortcutPlatform() === 'darwin'
  const [renderDiagnosticsArmed, setRenderDiagnosticsArmed] = useState(
    isTerminalRenderDesyncSentinelArmed
  )
  const onRenderDiagnosticsChange = (armed: boolean): void => {
    setTerminalRenderDesyncSentinelArmed(armed)
    setRenderDiagnosticsArmed(armed)
  }
  return (
    <section className="space-y-3 rounded-lg border border-status-warning-border bg-status-warning-background p-3">
      <h4 className="text-sm font-semibold text-status-warning-text">
        {t(
          'auto.components.settings.HiddenExperimentalGroup.f2c81d904a',
          'Hidden experimental settings'
        )}
      </h4>

      <div
        data-settings-row=""
        className="flex items-start justify-between gap-4 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2.5"
      >
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {t(
              'auto.components.settings.HiddenExperimentalGroup.b09f24a51d',
              'Terminal render diagnostics'
            )}
          </Label>
          <p className="text-xs text-status-warning-text">
            {t(
              'auto.components.settings.HiddenExperimentalGroup.7c4e18d2f6',
              'Arms the bold-glitch capture gestures on this machine: {{samplingShortcut}} starts a sampling burst; {{captureShortcut}} captures pane evidence to disk.',
              {
                samplingShortcut: isMac ? '⌘-click' : 'Ctrl+click',
                captureShortcut: isMac ? '⇧⌘-click' : 'Shift+Ctrl+click'
              }
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            'auto.components.settings.HiddenExperimentalGroup.b09f24a51d',
            'Terminal render diagnostics'
          )}
          checked={renderDiagnosticsArmed}
          onCheckedChange={onRenderDiagnosticsChange}
        />
      </div>
    </section>
  )
}
