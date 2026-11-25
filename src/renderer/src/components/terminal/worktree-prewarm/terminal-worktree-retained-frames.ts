import { useAppStore } from '@/store'

// The renderer's main canvas is the only unclassed one; its overlay layers carry an xterm-*-layer class.
function hasPresentableWebglFrame(screen: Element): boolean {
  const canvas = screen.querySelector(':scope > canvas:not([class])')
  if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) {
    return false
  }
  // Context loss clears the compositor texture; getContext returns the existing context, never a new one.
  const gl = canvas.getContext('webgl2')
  if (!gl || gl.isContextLost()) {
    return false
  }
  // A backing store sized for another device pixel ratio would show one mis-scaled frame.
  const cssWidth = Number.parseFloat(canvas.style.width)
  return cssWidth > 0 && Math.abs(canvas.width / cssWidth - window.devicePixelRatio) < 0.05
}

// A hidden xterm keeps its last frame while its WebGL texture survives; DOM rows count if rendered.
function hasRetainedTerminalFrame(terminalContainer: Element): boolean {
  const terminals = terminalContainer.querySelectorAll('.xterm')
  if (terminals.length === 0) {
    return false
  }
  for (const terminal of terminals) {
    const screen = terminal.querySelector('.xterm-screen')
    if (
      !screen ||
      (!hasPresentableWebglFrame(screen) &&
        !screen.querySelector('.xterm-rows')?.textContent?.trim())
    ) {
      return false
    }
  }
  return true
}

/** True when each group's visible terminal in a hidden workspace still holds a painted frame, so switching to it stays hot. */
export function hasRetainedWorkspaceTerminalFrames(worktreeId: string): boolean {
  const surface = [...document.querySelectorAll<HTMLElement>('[data-workspace-surface-id]')].find(
    (candidate) => candidate.getAttribute('data-workspace-surface-id') === worktreeId
  )
  if (!surface) {
    return false
  }
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  return (
    groups.length > 0 &&
    groups.every((group) => {
      const tab = tabs.find((candidate) => candidate.id === group.activeTabId)
      if (tab?.contentType !== 'terminal') {
        return false
      }
      const container = surface.querySelector(
        `[data-terminal-tab-id="${CSS.escape(tab.entityId)}"]`
      )
      return (
        container instanceof HTMLElement &&
        container.dataset.terminalChatView !== 'true' &&
        hasRetainedTerminalFrame(container)
      )
    })
  )
}
