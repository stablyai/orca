import { useEffect } from 'react'
import type { SkillsPageView } from './skills-page-view'

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
    const hasVisibleOverlay = (): boolean =>
      Array.from(
        document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
      ).some((element) => {
        if (!(element instanceof HTMLElement)) {
          return false
        }
        if (element.closest('[aria-hidden="true"]')) {
          return false
        }
        if (element.closest('[data-skills-page-list="true"]')) {
          return false
        }
        const style = window.getComputedStyle(element)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        )
      })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: menus and dialogs own Escape before page-level navigation.
      if (hasVisibleOverlay()) {
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
