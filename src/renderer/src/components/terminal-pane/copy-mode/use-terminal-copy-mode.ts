import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { registerTerminalCopyModeTarget } from './terminal-copy-mode-targets'
import { installCopyModeMenuGuard } from './terminal-copy-mode-menu'
import { installCopyModeKeyGuard } from './terminal-copy-mode-key-guard'
import { createTerminalCopyModeSessions } from './terminal-copy-mode-session'
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
  useEffect(() => {
    if (!isActive || !isVisible) {
      return
    }
    const scope = containerRef.current
    if (!scope) {
      return
    }
    const platform = getShortcutPlatform()
    const sessions = createTerminalCopyModeSessions({ scope, platform, managerRef })
    const releaseKeyGuard = installCopyModeKeyGuard()
    const unregister = registerTerminalCopyModeTarget(tabId, {
      available: sessions.available,
      enter: sessions.enter
    })
    const releaseMenuGuard = installCopyModeMenuGuard(sessions.ownedMenuView)
    const releaseInputRouting = installTerminalCopyModeInputRouting({ scope, platform, sessions })
    return () => {
      unregister()
      releaseKeyGuard()
      releaseMenuGuard()
      sessions.dispose()
      releaseInputRouting()
    }
  }, [tabId, isActive, isVisible, managerRef, containerRef])
}
