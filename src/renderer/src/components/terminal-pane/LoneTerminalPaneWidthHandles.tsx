import { useAppStore } from '../../store'
import {
  DEFAULT_SINGLE_PANE_MAX_WIDTH,
  TerminalSinglePaneWidthHandles
} from './TerminalSinglePaneWidthHandles'
import type { TerminalPaneController } from './use-terminal-pane-controller'

/** Width handles for the capped lone terminal pane; renders nothing once the tab area is split. */
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
    updateSettings,
    worktreeId
  } = controller
  const singlePaneMaxWidth = settings?.terminalSinglePaneMaxWidth ?? DEFAULT_SINGLE_PANE_MAX_WIDTH
  // Same predicate WorktreeSplitSurface uses; its effective-layout fallback can only
  // produce a leaf (split-group-mount.ts:7-23), so reading the raw map agrees. Read
  // here rather than threaded: this component is three prop hops from the layout owner.
  const tabAreaUnsplit = useAppStore((s) => s.layoutByWorktree?.[worktreeId]?.type !== 'split')
  if (
    singlePaneMaxWidth <= 0 ||
    !tabAreaUnsplit ||
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
