import React from 'react'
import type { ActivityBarPosition } from '@/store/slices/editor'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuRadioGroup,
  ContextMenuRadioItem
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'

// ─── Context Menu for Activity Bar Position ───────────
export function ActivityBarPositionMenu({
  currentPosition,
  onChangePosition,
  onDetectPerforce
}: {
  currentPosition: ActivityBarPosition
  onChangePosition: (pos: ActivityBarPosition) => void
  onDetectPerforce?: () => void
}): React.JSX.Element {
  return (
    <ContextMenuContent>
      <ContextMenuLabel>
        {translate('auto.components.right.sidebar.index.864111caa2', 'Activity Bar Position')}
      </ContextMenuLabel>
      <ContextMenuRadioGroup
        value={currentPosition}
        onValueChange={(v) => onChangePosition(v as ActivityBarPosition)}
      >
        <ContextMenuRadioItem value="top">
          {translate('auto.components.right.sidebar.index.7b415c39e9', 'Top')}
        </ContextMenuRadioItem>
        <ContextMenuRadioItem value="side">
          {translate('auto.components.right.sidebar.index.70893f017b', 'Side')}
        </ContextMenuRadioItem>
      </ContextMenuRadioGroup>
      {onDetectPerforce && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onDetectPerforce}>
            {translate(
              'auto.components.right.sidebar.index.detectPerforce',
              'Detect Perforce workspace'
            )}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  )
}
