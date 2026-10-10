import { useEffect } from 'react'
import type { SkillsPageView } from './skills-page-view'
import { hasVisibleOverlay } from '@/lib/visible-overlay'

type UseSkillsPageKeyboardNavigationOptions = {
  closeSkillsPage: () => void
  exitSelection: () => void
  exitSharedLinks: () => void
  selectionMode: 'share' | 'delete' | null
  view: SkillsPageView
}

export function useSkillsPageKeyboardNavigation({
  closeSkillsPage,
  exitSelection,
  exitSharedLinks,
  selectionMode,
  view
}: UseSkillsPageKeyboardNavigationOptions): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: menus and dialogs own Escape before page-level navigation.
      if (hasVisibleOverlay({ ignoreSelector: '[data-skills-page-list="true"]' })) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      ) {
        return
      }
      event.preventDefault()
      // Why: leaving the page would silently discard a selection that can hold dozens of skills.
      if (selectionMode) {
        exitSelection()
        return
      }
      if (view === 'shared') {
        exitSharedLinks()
        return
      }
      closeSkillsPage()
    }

    // Why: tooltips can consume Escape before bubble listeners see it.
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [closeSkillsPage, exitSelection, exitSharedLinks, selectionMode, view])
}
