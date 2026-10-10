import { useEffect } from 'react'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

export function useAutomationsPageEscape({
  store,
  local
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
}): void {
  const { activeModal, closeAutomationsPage } = store
  const {
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    selectedAutomationRunPageId,
    selectedExternalRunPage,
    pageView,
    runPageOrigin,
    setPageView,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId,
    setSelectedExternalRunPage
  } = local
  useEffect(() => {
    if (createOpen || deleteTarget || externalDeleteTarget || activeModal !== 'none') {
      return
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }

      // Popovers and menus are outside the store modal registry and own Escape.
      if (hasVisibleOverlay()) {
        return
      }

      const target = event.target
      if (target instanceof Element) {
        // Fields that clear their own value on Escape consume this press.
        if (target.getAttribute('data-escape-clears-value') === 'true') {
          return
        }

        // Esc first exits field focus, then exits the page, matching the Tasks page.
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof HTMLElement && target.isContentEditable) ||
          target.matches('[contenteditable="true"], [contenteditable=""]')
        ) {
          event.preventDefault()
          if (target instanceof HTMLElement) {
            target.blur()
          }
          return
        }
      }

      if (pageView === 'run') {
        event.preventDefault()
        setSelectedAutomationRunPageId(null)
        setPageView(runPageOrigin === 'automation' ? 'automations' : 'runs')
        setIsDetailOpen(runPageOrigin === 'automation')
        setActivePaneTab(runPageOrigin === 'automation' ? 'runs' : 'overview')
        return
      }

      if (isDetailOpen) {
        event.preventDefault()
        if (selectedExternalRunPage) {
          setSelectedExternalRunPage(null)
          return
        }
        if (selectedAutomationRunPageId) {
          setSelectedAutomationRunPageId(null)
          return
        }
        setIsDetailOpen(false)
        setActivePaneTab('overview')
        return
      }

      if (pageView === 'runs') {
        event.preventDefault()
        setPageView('automations')
        return
      }

      event.preventDefault()
      closeAutomationsPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeModal,
    closeAutomationsPage,
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    pageView,
    runPageOrigin,
    selectedAutomationRunPageId,
    selectedExternalRunPage,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId,
    setSelectedExternalRunPage,
    setPageView
  ])
}
