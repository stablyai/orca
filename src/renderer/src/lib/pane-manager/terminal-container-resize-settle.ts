let activeTerminalContainerResizeSettles = 0

export function beginTerminalContainerResizeSettle(): () => void {
  let released = false
  activeTerminalContainerResizeSettles += 1

  return () => {
    if (released) {
      return
    }
    released = true
    activeTerminalContainerResizeSettles = Math.max(0, activeTerminalContainerResizeSettles - 1)
  }
}

export function isTerminalContainerResizeSettling(): boolean {
  return activeTerminalContainerResizeSettles > 0
}

export function resetTerminalContainerResizeSettleForTests(): void {
  activeTerminalContainerResizeSettles = 0
}
