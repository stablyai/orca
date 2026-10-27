import type { PtyPaneStartup } from '@/components/terminal-pane/pty-connection-types'

export type MountedAgentSessionRestarter = (startup: PtyPaneStartup) => boolean

const restarters = new Map<string, MountedAgentSessionRestarter>()
let onRegistered: (() => void) | null = null

/** The open terminal owns xterm reconnection. Detached spawn must not race it. */
export function registerMountedAgentSessionRestart(
  ptyId: string,
  restarter: MountedAgentSessionRestarter
): () => void {
  restarters.set(ptyId, restarter)
  onRegistered?.()
  return () => {
    if (restarters.get(ptyId) === restarter) {
      restarters.delete(ptyId)
    }
  }
}

export function getMountedAgentSessionRestart(
  ptyId: string
): MountedAgentSessionRestarter | undefined {
  return restarters.get(ptyId)
}

export function setMountedAgentSessionRestartListener(listener: (() => void) | null): void {
  onRegistered = listener
}

export function resetMountedAgentSessionRestartsForTests(): void {
  restarters.clear()
  onRegistered = null
}
