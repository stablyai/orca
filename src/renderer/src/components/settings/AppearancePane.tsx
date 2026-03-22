import type { GlobalSettings } from '../../../../shared/types'
import { Separator } from '../ui/separator'
import { UIZoomControl } from './UIZoomControl'

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
}

export function AppearancePane({
  settings,
  updateSettings,
  applyTheme
}: AppearancePaneProps): React.JSX.Element {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Theme</h2>
          <p className="text-xs text-muted-foreground">Choose how Orca looks in the app window.</p>
        </div>

        <div className="flex w-fit gap-1 rounded-md border p-1">
          {(['system', 'dark', 'light'] as const).map((option) => (
            <button
              key={option}
              onClick={() => {
                updateSettings({ theme: option })
                applyTheme(option)
              }}
              className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                settings.theme === option
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">UI Zoom</h2>
          <p className="text-xs text-muted-foreground">
            Scale the entire application interface. Use{' '}
            <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘+</kbd> /{' '}
            <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘-</kbd> when not in a terminal
            pane.
          </p>
        </div>

        <UIZoomControl />
      </section>
    </div>
  )
}
