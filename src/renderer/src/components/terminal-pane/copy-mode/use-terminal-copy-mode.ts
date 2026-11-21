import { useEffect, useRef } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { registerTerminalCopyModeTarget } from './terminal-copy-mode-targets'
import { installCopyModeMenuGuard } from './terminal-copy-mode-menu'
import { installCopyModeKeyGuard } from './terminal-copy-mode-key-guard'
import {
  createTerminalCopyModeSessions,
  type TerminalCopyModeSessions
} from './terminal-copy-mode-session'
import { installTerminalCopyModeInputRouting } from './terminal-copy-mode-input-routing'

export function useTerminalCopyMode({
  tabId,
  isActive,
  isVisible,
  managerRef,
  containerRef
}: {
  tabId: string
  isActive: boolean
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLElement | null>
}): void {
  const isVisibleRef = useRef(isVisible)
  const sessionsRef = useRef<TerminalCopyModeSessions | null>(null)

  useEffect(() => {
    isVisibleRef.current = isVisible
    if (!isVisible) {
      sessionsRef.current?.close()
    }
  }, [isVisible])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const scope = containerRef.current
    if (!scope) {
      return
    }
    const platform = getShortcutPlatform()
    // Keep registration tied to isActive so visibility toggles never reorder capture listeners behind terminal shortcuts.
    const sessions = createTerminalCopyModeSessions({
      scope,
      platform,
      managerRef,
      isVisible: () => isVisibleRef.current
    })
    sessionsRef.current = sessions
    const releaseKeyGuard = installCopyModeKeyGuard()
    const unregister = registerTerminalCopyModeTarget(tabId, {
      available: sessions.available,
      enter: sessions.enter
    })
    const releaseMenuGuard = installCopyModeMenuGuard(sessions.ownedMenuView)
    const releaseInputRouting = installTerminalCopyModeInputRouting({ scope, platform, sessions })
    return () => {
      sessionsRef.current = null
      unregister()
      releaseKeyGuard()
      releaseMenuGuard()
      sessions.dispose()
      releaseInputRouting()
    }
  }, [tabId, isActive, managerRef, containerRef])
}
