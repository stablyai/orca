import type { RecoveryPresentationInput } from '../../../shared/cross-machine-recovery-presentation-types'

export const MAX_TRACKED_INPUT_PANES_PER_WORKSPACE = 64

const HUMAN_INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const

export type HumanInputScope = { workspaceKey: string | null; paneKey: string | null }

export type HumanInputActivityKind = 'input' | 'focus'

type HumanInputEvent = { type: string; isTrusted: boolean; target: unknown }

type HumanInputEventTarget = {
  addEventListener: (
    type: string,
    listener: (event: HumanInputEvent) => void,
    options?: AddEventListenerOptions
  ) => void
  removeEventListener: (
    type: string,
    listener: (event: HumanInputEvent) => void,
    options?: EventListenerOptions
  ) => void
}

export type HumanInputActivityTracker = {
  windowFocused: () => boolean
  /** Ages at this instant; focus reads 0 while the focused window shows `workspaceKey`. */
  inputFor: (workspaceKey: string, activeWorkspaceKey: string | null) => RecoveryPresentationInput
  /** Stamps the moment a focused window navigated away from `workspaceKey`. */
  noteWorkspaceLeft: (workspaceKey: string) => void
  subscribe: (listener: (kind: HumanInputActivityKind) => void) => () => void
  dispose: () => void
}

export function createHumanInputActivityTracker(options: {
  target: HumanInputEventTarget
  initiallyFocused: boolean
  scope: () => HumanInputScope
  now?: () => number
}): HumanInputActivityTracker {
  const readClock = options.now ?? (() => performance.now())
  let lastStamp = Number.NEGATIVE_INFINITY
  let windowFocused = options.initiallyFocused
  const inputAtByWorkspace = new Map<string, number>()
  const focusAtByWorkspace = new Map<string, number>()
  const inputAtByPaneByWorkspace = new Map<string, Map<string, number>>()
  const listeners = new Set<(kind: HumanInputActivityKind) => void>()

  // Why: ages must never go negative even if the injected clock steps backwards.
  const clock = (): number => {
    lastStamp = Math.max(lastStamp, readClock())
    return lastStamp
  }
  const notify = (kind: HumanInputActivityKind): void => {
    for (const listener of listeners) {
      listener(kind)
    }
  }
  const stampPane = (workspaceKey: string, paneKey: string, at: number): void => {
    let panes = inputAtByPaneByWorkspace.get(workspaceKey)
    if (!panes) {
      panes = new Map()
      inputAtByPaneByWorkspace.set(workspaceKey, panes)
    }
    panes.delete(paneKey)
    panes.set(paneKey, at)
    if (panes.size > MAX_TRACKED_INPUT_PANES_PER_WORKSPACE) {
      const oldest = panes.keys().next().value
      if (oldest !== undefined) {
        panes.delete(oldest)
      }
    }
  }

  const onHumanInput = (event: HumanInputEvent): void => {
    if (!event.isTrusted) {
      return
    }
    const at = clock()
    const { workspaceKey, paneKey } = options.scope()
    if (workspaceKey) {
      inputAtByWorkspace.set(workspaceKey, at)
      focusAtByWorkspace.set(workspaceKey, at)
      if (paneKey) {
        stampPane(workspaceKey, paneKey, at)
      }
    }
    notify('input')
  }
  const onWindowFocusChange = (event: HumanInputEvent): void => {
    // Why the target check: element focus/blur also passes through window during capture.
    if (!event.isTrusted || event.target !== options.target) {
      return
    }
    const { workspaceKey } = options.scope()
    if (workspaceKey) {
      focusAtByWorkspace.set(workspaceKey, clock())
    }
    windowFocused = event.type === 'focus'
    notify('focus')
  }

  for (const type of HUMAN_INPUT_EVENTS) {
    options.target.addEventListener(type, onHumanInput, { capture: true, passive: true })
  }
  options.target.addEventListener('focus', onWindowFocusChange, { capture: true })
  options.target.addEventListener('blur', onWindowFocusChange, { capture: true })

  const age = (at: number | undefined, now: number): number | null =>
    at === undefined ? null : Math.floor(now - at)

  return {
    windowFocused: () => windowFocused,
    inputFor: (workspaceKey, activeWorkspaceKey) => {
      const now = clock()
      const showing = windowFocused && workspaceKey === activeWorkspaceKey
      const byPane: Record<string, number> = {}
      for (const [paneKey, at] of inputAtByPaneByWorkspace.get(workspaceKey) ?? []) {
        byPane[paneKey] = Math.floor(now - at)
      }
      return {
        msSinceHumanInput: age(inputAtByWorkspace.get(workspaceKey), now),
        msSinceHumanFocus: showing ? 0 : age(focusAtByWorkspace.get(workspaceKey), now),
        msSinceHumanInputByPaneKey: byPane
      }
    },
    noteWorkspaceLeft: (workspaceKey) => {
      if (windowFocused) {
        focusAtByWorkspace.set(workspaceKey, clock())
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      for (const type of HUMAN_INPUT_EVENTS) {
        options.target.removeEventListener(type, onHumanInput, { capture: true })
      }
      options.target.removeEventListener('focus', onWindowFocusChange, { capture: true })
      options.target.removeEventListener('blur', onWindowFocusChange, { capture: true })
      listeners.clear()
    }
  }
}
