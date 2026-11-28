import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { AutomationPaneTab } from '../automation-page-state'
import {
  getAutomationDetailNextTab,
  isAutomationDetailTabArrowKey,
  shouldHandleAutomationDetailEscapeKey,
  shouldHandleAutomationDetailTabArrowKey
} from './automation-detail-tab-navigation'

/**
 * Escape leaves an automation's detail; Left/Right move between its tabs where it has them.
 * `scope: 'window'` is the page, which owns the whole window while it shows. An element scope (a
 * side panel) hears keys only while focus is inside it, so it never takes Escape from the rest of
 * the window.
 */
export function useAutomationDetailKeys({
  scope,
  onBack,
  tabs
}: {
  scope: 'window' | RefObject<HTMLElement | null>
  onBack: () => void
  tabs?: {
    current: AutomationPaneTab
    canAccessRuns: boolean
    onChange: (tab: AutomationPaneTab) => void
  } | null
}): void {
  const latest = useRef({ onBack, tabs })
  useLayoutEffect(() => {
    latest.current = { onBack, tabs }
  })
  useEffect(() => {
    const handleKeyDown = (event: Event): void => {
      if (!(event instanceof KeyboardEvent)) {
        return
      }
      if (shouldHandleAutomationDetailEscapeKey(event)) {
        event.preventDefault()
        // A panel's Escape is its own; the page's window handler is the outermost.
        if (scope !== 'window') {
          event.stopPropagation()
        }
        latest.current.onBack()
        return
      }
      const current = latest.current.tabs
      if (
        current &&
        isAutomationDetailTabArrowKey(event.key) &&
        shouldHandleAutomationDetailTabArrowKey(event)
      ) {
        const nextTab = getAutomationDetailNextTab({
          currentTab: current.current,
          key: event.key,
          canAccessRuns: current.canAccessRuns
        })
        if (nextTab && nextTab !== current.current) {
          event.preventDefault()
          current.onChange(nextTab)
        }
      }
    }
    const target: EventTarget | null = scope === 'window' ? window : scope.current
    if (!target) {
      return
    }
    target.addEventListener('keydown', handleKeyDown)
    return () => target.removeEventListener('keydown', handleKeyDown)
  }, [scope])
}
