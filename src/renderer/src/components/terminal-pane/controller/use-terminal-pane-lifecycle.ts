import { useLayoutEffect } from 'react'
import { useTerminalPaneHibernationWake } from '../mounting/use-terminal-pane-hibernation-wake'
import { useTerminalPaneProcessVisibility } from '../viewport/visibility/use-terminal-pane-process-visibility'
import { useTerminalForegroundAgentSampling } from '../input/focus/use-terminal-foreground-agent-sampling'
import { useMountedTerminalAppearance } from '../appearance/use-mounted-terminal-appearance'
import { useTerminalGpuPreference } from '../appearance/use-terminal-gpu-preference'
import { useMountedTerminalScrollback } from '../appearance/use-mounted-terminal-scrollback'
import { useTerminalMouseHidePreference } from '../input/pointer/use-terminal-mouse-hide-preference'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../../shared/terminal/replay/terminal-scrollback-policy'
import type { UseTerminalPaneLifecycleDeps } from '../mounting/terminal-pane-lifecycle-types'
import { useTerminalPaneMountLifecycle } from '../mounting/use-terminal-pane-mount-lifecycle'
import { useTerminalPaneLifecycleRefs } from '../mounting/use-terminal-pane-lifecycle-refs'

export function useTerminalPaneLifecycle(deps: UseTerminalPaneLifecycleDeps) {
  const refs = useTerminalPaneLifecycleRefs()
  const mount = useTerminalPaneMountLifecycle(deps, refs)
  const mountedDeps = { ...deps, mountedManager: mount.manager }

  const terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
    deps.settings?.terminalScrollbackRows
  )
  const { systemPrefersDarkRef } = refs
  const { systemPrefersDark } = deps
  // Layout phase: the mount and appearance passive effects read it after this commit.
  useLayoutEffect(() => {
    systemPrefersDarkRef.current = systemPrefersDark
  }, [systemPrefersDarkRef, systemPrefersDark])

  useTerminalPaneHibernationWake(deps)

  useTerminalPaneProcessVisibility(mountedDeps, refs)

  useTerminalForegroundAgentSampling(deps)

  useMountedTerminalAppearance(mountedDeps, systemPrefersDarkRef)

  useTerminalGpuPreference(mountedDeps)

  useMountedTerminalScrollback(mountedDeps, terminalScrollbackRows)

  useTerminalMouseHidePreference(mountedDeps, refs)
  return mount
}
