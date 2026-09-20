import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

export const MANAGE_SESSIONS_SECTION_ID = 'terminal-manage-sessions'

type MacTccAttributionSeveredState = {
  severed: boolean
  /** Live sessions the app declined to kill when it wanted to replace the daemon; null when unknown. */
  preservedSessionCount: number | null
}

const HEALTHY_STATE: MacTccAttributionSeveredState = { severed: false, preservedSessionCount: null }

/**
 * Why this exists: macOS pins the TCC "responsible process" of the detached terminal
 * daemon to the app binary that forked it. Once that binary is deleted (packaged
 * updates replace the bundle), Accessibility/Automation grants on Orca silently stop
 * covering every daemon-hosted terminal (osascript -25211) with no OS-side signal —
 * so the remedy has to be surfaced here, next to the permissions it breaks (STA-3491).
 */
export function useMacTccAttributionSevered(refreshRevision = 0): MacTccAttributionSeveredState {
  const [state, setState] = useState<MacTccAttributionSeveredState>(HEALTHY_STATE)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { health, deferredReplacement } = await window.api.pty.management.macTccAttribution()
      setState(
        health === 'severed'
          ? {
              severed: true,
              preservedSessionCount:
                deferredReplacement?.reason === 'severed_tcc_attribution'
                  ? deferredReplacement.liveSessionCount
                  : null
            }
          : HEALTHY_STATE
      )
    } catch {
      setState(HEALTHY_STATE)
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

  return state
}

export function TerminalTccAttributionNotice(props: {
  /** The Manage Sessions surface hosts the fix itself, so it hides the navigation button. */
  showManageSessionsButton?: boolean
  /** Increment after a daemon replacement attempt so the remedy state is re-checked. */
  refreshRevision?: number
}): React.JSX.Element | null {
  const { severed, preservedSessionCount } = useMacTccAttributionSevered(props.refreshRevision)
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
              'The terminal daemon is running from an Orca install that an update has since replaced, so macOS can’t attribute its commands to Orca. Its terminals are silently denied Documents, Desktop and Downloads, Local Network, and Accessibility and Automation grants (osascript fails with error -25211). Restarting the daemon fixes this; running terminal sessions will close.'
            )}
          </p>
          {preservedSessionCount !== null && preservedSessionCount > 0 && (
            <p className="text-xs leading-snug">
              {translate(
                'auto.components.settings.TerminalTccAttributionNotice.preservedSessions',
                'Orca did not restart it automatically because it still owns live terminal sessions ({{value0}}).',
                { value0: preservedSessionCount }
              )}
            </p>
          )}
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
