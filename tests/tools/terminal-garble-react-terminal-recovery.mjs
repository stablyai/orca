export function recoverProductionTerminalRefs() {
  const terminals = []
  const seenTerminals = new Set()
  const seenObjects = new Set()

  const remember = (candidate) => {
    try {
      if (
        candidate &&
        typeof candidate === 'object' &&
        typeof candidate.rows === 'number' &&
        typeof candidate.cols === 'number' &&
        typeof candidate.buffer?.active?.getLine === 'function' &&
        candidate.element instanceof HTMLElement &&
        !seenTerminals.has(candidate)
      ) {
        seenTerminals.add(candidate)
        terminals.push(candidate)
        return true
      }
      if (
        candidate &&
        typeof candidate.getPanes === 'function' &&
        typeof candidate.getActivePane === 'function'
      ) {
        for (const pane of candidate.getPanes() ?? []) {
          remember(pane?.terminal)
        }
        return true
      }
    } catch {
      // Production objects can expose disposed getters while React cleans up.
    }
    return false
  }

  const inspect = (candidate, depth) => {
    if (!candidate || typeof candidate !== 'object' || seenObjects.has(candidate)) {
      return
    }
    seenObjects.add(candidate)
    if (remember(candidate) || depth <= 0 || candidate instanceof Node) {
      return
    }
    if (candidate instanceof Map || candidate instanceof Set) {
      for (const value of candidate.values()) {
        inspect(value, depth - 1)
      }
      return
    }
    for (const key of Object.keys(candidate).slice(0, 80)) {
      if (key === 'return' || key === 'child' || key === 'sibling' || key.startsWith('__react')) {
        continue
      }
      try {
        inspect(candidate[key], depth - 1)
      } catch {
        // Treat opaque host objects as leaves.
      }
    }
  }

  for (const xterm of document.querySelectorAll('.xterm')) {
    let root = xterm
    let fiberKey = null
    while (root && !fiberKey) {
      fiberKey = Object.keys(root).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      )
      if (!fiberKey) {
        root = root.parentElement
      }
    }
    let fiber = fiberKey && root ? root[fiberKey] : null
    let ancestorCount = 0
    while (fiber && ancestorCount < 80) {
      let hook = fiber.memoizedState
      let hookCount = 0
      while (hook && hookCount < 600) {
        inspect(hook.memoizedState, 5)
        hook = hook.next
        hookCount++
      }
      inspect(fiber.memoizedProps, 3)
      fiber = fiber.return
      ancestorCount++
    }
  }

  // Why: packaged builds omit the E2E manager exposure, but a buffer oracle
  // is required to distinguish real render corruption from valid TUI rewrites.
  window.__terminalGarbleTerminals = terminals
  return terminals.map((terminal) => ({
    cols: terminal.cols,
    rows: terminal.rows,
    visible: Boolean(terminal.element?.offsetWidth && terminal.element?.offsetHeight)
  }))
}
