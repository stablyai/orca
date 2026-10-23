import { useLayoutEffect, useMemo, useRef } from 'react'
import { clearClientHostedBrowserRowSelection } from '@/lib/pane-manager/client-hosted-browser-row-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { TabBarItem } from './tab-bar-item-model'
import type { TabBarProps } from './tab-bar-props'
import { withLayoutOwnerTabProps } from './tab-bar-layout-owner-props'

type TabBarItemActionSource = {
  props: Pick<
    TabBarProps,
    | 'worktreeId'
    | 'onActivate'
    | 'onActivateFile'
    | 'onActivateBrowserTab'
    | 'onActivateAgentSession'
    | 'onClose'
    | 'onCloseFile'
    | 'onCloseBrowserTab'
    | 'onCloseOthers'
    | 'onCloseToRight'
    | 'onCloseToLeft'
    | 'onCloseSplitPane'
    | 'onCloseAllFiles'
    | 'onSetCustomTitle'
    | 'onSetTabColor'
    | 'onTogglePaneExpand'
    | 'onDuplicateBrowserTab'
    | 'onMakePreviewFilePermanent'
  >
  togglePinned: (item: TabBarItem) => void
  toggleTabViewMode: (tabId: string) => void
}

export type TabBarItemActions = {
  activateTerminal: (tabId: string) => void
  activateFile: (fileId: string) => void
  activateBrowserTab: (tabId: string) => void
  activateAgentSession: (tabId: string) => void
  close: (tabId: string) => void
  closeFile: (fileId: string) => void
  closeBrowserTab: (tabId: string) => void
  closeOthers: (tabId: string) => void
  closeToRight: (tabId: string) => void
  closeToLeft: (tabId: string) => void
  closeSplitPane: () => void
  closeAllFiles: () => void
  setCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  togglePaneExpand: (tabId: string) => void
  duplicateBrowserTab: (tabId: string, unifiedTabId: string) => void
  makePreviewFilePermanent: (fileId: string, tabId?: string) => void
  togglePinned: (item: TabBarItem) => void
  toggleViewMode: (tabId: string) => void
}

/** Actions that read the strip's handlers when called, so their own identity never has to change. */
export function useTabBarItemActions(source: TabBarItemActionSource): TabBarItemActions {
  const latest = useRef(source)
  // Why an effect: a render React abandons must not hand its handlers to the tabs already on screen.
  useLayoutEffect(() => {
    latest.current = source
  })
  return useMemo(() => {
    // Why: this is the strip's single activation fan-out, so retiring a client-hosted placeholder
    // here covers every row kind — including re-clicking the tab that was already active, which the
    // group's activeTabId never moves for.
    function activateRealTab(activate: () => void): void {
      clearClientHostedBrowserRowSelection()
      activate()
    }
    const actions: TabBarItemActions = {
      activateTerminal: (tabId) => activateRealTab(() => latest.current.props.onActivate(tabId)),
      activateFile: (fileId) =>
        activateRealTab(() => latest.current.props.onActivateFile?.(fileId)),
      activateBrowserTab: (tabId) =>
        activateRealTab(() => latest.current.props.onActivateBrowserTab?.(tabId)),
      activateAgentSession: (tabId) =>
        activateRealTab(() => latest.current.props.onActivateAgentSession?.(tabId)),
      close: (tabId) => latest.current.props.onClose(tabId),
      closeFile: (fileId) => latest.current.props.onCloseFile?.(fileId),
      closeBrowserTab: (tabId) => latest.current.props.onCloseBrowserTab?.(tabId),
      closeOthers: (tabId) => latest.current.props.onCloseOthers(tabId),
      closeToRight: (tabId) => latest.current.props.onCloseToRight(tabId),
      closeToLeft: (tabId) => latest.current.props.onCloseToLeft(tabId),
      closeSplitPane: () => latest.current.props.onCloseSplitPane?.(),
      closeAllFiles: () => latest.current.props.onCloseAllFiles?.(),
      setCustomTitle: (tabId, title) => latest.current.props.onSetCustomTitle(tabId, title),
      setTabColor: (tabId, color) => latest.current.props.onSetTabColor(tabId, color),
      togglePaneExpand: (tabId) => latest.current.props.onTogglePaneExpand(tabId),
      duplicateBrowserTab: (tabId, unifiedTabId) =>
        latest.current.props.onDuplicateBrowserTab?.(tabId, unifiedTabId),
      makePreviewFilePermanent: (fileId, tabId) =>
        latest.current.props.onMakePreviewFilePermanent?.(fileId, tabId),
      togglePinned: (item) => latest.current.togglePinned(item),
      toggleViewMode: (tabId) => latest.current.toggleTabViewMode(tabId)
    }
    // Switch point: pin goes to main first (rename, color and view do from their store actions).
    return ORCA_LAYOUT_OWNER_IS_MAIN
      ? { ...actions, ...withLayoutOwnerTabProps(actions, () => latest.current.props.worktreeId) }
      : actions
  }, [])
}
