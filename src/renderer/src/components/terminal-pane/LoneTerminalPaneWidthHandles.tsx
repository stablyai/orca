import {
  DEFAULT_SINGLE_PANE_MAX_WIDTH,
  TerminalSinglePaneWidthHandles
} from './TerminalSinglePaneWidthHandles'
import type { TerminalPaneController } from './use-terminal-pane-controller'

/** Width handles for the capped lone terminal pane; renders nothing once the tab is split. */
export function LoneTerminalPaneWidthHandles({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    activePaneIsChatLeaf,
    containerRef,
    effectiveChatViewMode,
    paneCount,
    settings,
    terminalContentVisible,
    terminalDividerStyle,
    updateSettings
  } = controller
  const singlePaneMaxWidth = settings?.terminalSinglePaneMaxWidth ?? DEFAULT_SINGLE_PANE_MAX_WIDTH
  if (
    singlePaneMaxWidth <= 0 ||
    paneCount !== 1 ||
    !terminalContentVisible ||
    (effectiveChatViewMode && activePaneIsChatLeaf)
  ) {
    return null
  }
  return (
    <TerminalSinglePaneWidthHandles
      containerRef={containerRef}
      maxWidth={singlePaneMaxWidth}
      dividerStyle={terminalDividerStyle}
      onCommit={(value) => updateSettings({ terminalSinglePaneMaxWidth: value })}
    />
  )
}
