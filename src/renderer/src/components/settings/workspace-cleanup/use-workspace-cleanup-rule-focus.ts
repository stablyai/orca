import { useRef, type RefObject } from 'react'
import type { WorkspaceCleanupRuleKey } from './workspace-cleanup-rule-keys'

/**
 * How a rule change ended. `host-unavailable`: the host's rules could not be read, and the page
 * shows that instead. `busy`: another change was in flight, so this one did nothing.
 */
export type WorkspaceCleanupChangeOutcome =
  | 'saved'
  | 'confirming'
  | 'check-failed'
  | 'save-failed'
  | 'host-unavailable'
  | 'busy'
  | 'unmounted'

/** Hands focus back to the rule switch that started a change, only while the page still shows it. */
export function useWorkspaceCleanupRuleFocus(mountedRef: RefObject<boolean>): {
  registerSwitch: (key: WorkspaceCleanupRuleKey, element: HTMLButtonElement | null) => void
  focusRule: (key: WorkspaceCleanupRuleKey) => boolean
  settleFocus: (key: WorkspaceCleanupRuleKey, outcome: WorkspaceCleanupChangeOutcome) => void
} {
  const switches = useRef(new Map<WorkspaceCleanupRuleKey, HTMLButtonElement>())

  const focusRule = (key: WorkspaceCleanupRuleKey): boolean => {
    const element = switches.current.get(key)
    if (
      !mountedRef.current ||
      !element?.isConnected ||
      (typeof element.checkVisibility === 'function' && !element.checkVisibility())
    ) {
      return false
    }
    element.focus()
    return true
  }

  return {
    registerSwitch: (key, element) => {
      if (element) {
        switches.current.set(key, element)
      } else {
        switches.current.delete(key)
      }
    },
    focusRule,
    // Keeps focus on the switch that started the change unless the user has moved it on purpose.
    settleFocus: (key, outcome) => {
      if (outcome !== 'saved' && outcome !== 'check-failed' && outcome !== 'save-failed') {
        return
      }
      const active = document.activeElement
      if (!active || active === document.body || active === switches.current.get(key)) {
        focusRule(key)
      }
    }
  }
}
