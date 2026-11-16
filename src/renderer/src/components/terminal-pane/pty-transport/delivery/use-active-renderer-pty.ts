import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useEffect } from 'react'

export function useActiveRendererPty({
  isActive,
  isVisible,
  isWorktreeActive,
  activeLeafPtyId
}: {
  isActive: boolean
  isVisible: boolean
  isWorktreeActive: boolean
  activeLeafPtyId: string | null
}): void {
  useEffect(() => {
    const ptyId = isActive && isVisible && isWorktreeActive ? activeLeafPtyId : null
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      return
    }
    // Main prioritizes this PTY’s bounded ACK reserve; cleanup deactivates the old binding before rebind.
    window.api.pty.setActiveRendererPty?.(ptyId, true)
    return () => window.api.pty.setActiveRendererPty?.(ptyId, false)
  }, [isActive, isVisible, isWorktreeActive, activeLeafPtyId])
}
