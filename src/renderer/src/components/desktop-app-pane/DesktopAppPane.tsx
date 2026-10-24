import { useState } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import { DesktopAppPaneToolbar, windowLabel } from './desktop-app-pane-toolbar'
import { DesktopAppWindowView } from './DesktopAppWindowView'
import { useDesktopAppCapture } from './use-desktop-app-capture'
import { useDesktopAppWindows } from './use-desktop-app-windows'
import { translate } from '@/i18n/i18n'

type DesktopAppPaneProps = {
  tab: Tab
  isActive: boolean
}

/** A native app window shown live inside Orca, driven by the user or by an agent. */
export default function DesktopAppPane({ tab, isActive }: DesktopAppPaneProps): React.JSX.Element {
  const windows = useDesktopAppWindows(tab.id, isActive)
  const capture = useDesktopAppCapture(windows.selected, isActive)
  const [inputError, setInputError] = useState<string | null>(null)
  const error = windows.error ?? capture.error ?? inputError

  return (
    <div
      data-desktop-app-pane
      className="flex h-full min-h-0 flex-col bg-background text-sm text-foreground"
    >
      <DesktopAppPaneToolbar
        windows={windows.windows}
        selected={windows.selected}
        captureStatus={
          !windows.selected || capture.error ? null : capture.stream ? 'live' : 'connecting'
        }
        loading={windows.loading}
        onSelectWindow={windows.select}
        onRefresh={() => void windows.refresh()}
      />
      {error ? (
        <div className="border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {windows.selected ? (
        <DesktopAppWindowView
          target={windows.selected}
          stream={capture.stream}
          onInputError={setInputError}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-muted scrollbar-sleek px-6 py-8">
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.desktop.app.pane.DesktopAppPane.c294a5cd7e',
              'Pick an app window to show it here. You and your agents can click, scroll and type in it without leaving Orca.'
            )}
          </p>
          <div className="flex w-full max-w-md flex-col gap-1">
            {windows.windows.map((w) => (
              <button
                key={`${w.pid}:${w.windowId}`}
                type="button"
                onClick={() => windows.select(w)}
                className="truncate rounded-md px-3 py-2 text-left text-xs hover:bg-accent hover:text-accent-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              >
                {windowLabel(w)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
