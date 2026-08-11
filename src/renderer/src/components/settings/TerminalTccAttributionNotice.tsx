import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

export const MANAGE_SESSIONS_SECTION_ID = 'terminal-manage-sessions'

/**
 * Why this exists: macOS pins the TCC "responsible process" of the detached terminal
 * daemon to the app binary that forked it. Once that binary is deleted (packaged
 * updates replace the bundle), Accessibility/Automation grants on Orca silently stop
 * covering every daemon-hosted terminal (osascript -25211) with no OS-side signal —
 * so the remedy has to be surfaced here, next to the permissions it breaks (STA-3491).
 */
export function useMacTccAttributionSevered(refreshRevision = 0): boolean {
  const [severed, setSevered] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { health } = await window.api.pty.management.macTccAttribution()
      setSevered(health === 'severed')
    } catch {
      setSevered(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Why: a daemon restart or drain changes the verdict without a pane remount.
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, refreshRevision])

  return severed
}

export function TerminalTccAttributionNotice(props: {
  /** The Manage Sessions surface hosts the fix itself, so it hides the navigation button. */
  showManageSessionsButton?: boolean
  /** Increment after a daemon replacement attempt so the remedy state is re-checked. */
  refreshRevision?: number
}): React.JSX.Element | null {
  const severed = useMacTccAttributionSevered(props.refreshRevision)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)

  if (!severed) {
    return null
  }

  const openManageSessions = (): void => {
    // Why: a stale Settings search would hide the Manage Sessions section this points at.
    setSettingsSearchQuery('')
    openSettingsTarget({
      pane: 'terminal',
      repoId: null,
      sectionId: MANAGE_SESSIONS_SECTION_ID
    })
    openSettingsPage()
  }

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-700 dark:text-amber-300"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.settings.TerminalTccAttributionNotice.title',
              'macOS permission grants aren’t reaching terminals'
            )}
          </p>
          <p className="text-xs leading-snug">
            {translate(
              'auto.components.settings.TerminalTccAttributionNotice.body',
              'The terminal daemon was started by an Orca install that no longer exists, so macOS can’t attribute its commands to Orca — Accessibility and Automation grants are silently ignored (osascript fails with error -25211). Restarting the daemon fixes this; running terminal sessions will close.'
            )}
          </p>
        </div>
      </div>
      {props.showManageSessionsButton !== false && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={openManageSessions}>
          {translate(
            'auto.components.settings.TerminalTccAttributionNotice.openManageSessions',
            'Open Manage Sessions'
          )}
        </Button>
      )}
    </div>
  )
}
