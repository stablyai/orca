import { useEffect } from 'react'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import type { AutomationsPageNavigation } from './automations-page-navigation'

export function useAutomationsPageEscape({
  store,
  local,
  navigation
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  navigation: AutomationsPageNavigation
}): void {
  const { activeModal, closeAutomationsPage } = store
  const {
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    activePaneTab,
    pageView,
    runPageOrigin,
    runNotFound
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

      event.preventDefault()
      // Escape undoes the last step: a run returns where it was opened from.
      if (pageView === 'run') {
        if (runNotFound) {
          if (runNotFound.kind === 'run' && isDetailOpen) {
            navigation.returnFromRun(runPageOrigin)
          } else {
            navigation.showList()
          }
          return
        }
        navigation.returnFromRun(runPageOrigin)
        return
      }
      if (isDetailOpen) {
        if (activePaneTab === 'runs') {
          navigation.showSelectedAutomation()
          return
        }
        navigation.showList()
        return
      }
      if (pageView === 'runs') {
        navigation.showList()
        return
      }
      closeAutomationsPage()
    }

    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [
    activeModal,
    activePaneTab,
    closeAutomationsPage,
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    navigation,
    pageView,
    runNotFound,
    runPageOrigin
  ])
}
