import { useState } from 'react'
import { useAppStore } from '../../../store/index'
import type { TerminalPaneChatController } from '../chat/use-terminal-pane-chat-state'

export function useTerminalStartupMeasurementState({
  isVisible,
  measureWhileHidden,
  tabId
}: Pick<TerminalPaneChatController, 'isVisible' | 'measureWhileHidden' | 'tabId'>) {
  const [startup] = useState(() => useAppStore.getState().pendingStartupByTabId[tabId])
  const [shouldMeasureHiddenStartupState, setShouldMeasureHiddenStartup] = useState(
    () => startup !== undefined && !isVisible
  )
  const shouldMeasureHiddenStartup =
    shouldMeasureHiddenStartupState || (measureWhileHidden === true && !isVisible)
  return { startup, shouldMeasureHiddenStartup, setShouldMeasureHiddenStartup }
}
