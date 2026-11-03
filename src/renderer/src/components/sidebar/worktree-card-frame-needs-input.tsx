import React from 'react'
import { translate } from '@/i18n/i18n'

/** The frame's own needs-input mark on plugin cards, outside the template's reach. */
export function WorktreeCardFrameNeedsInput(): React.JSX.Element {
  return (
    <span
      className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-status-warning"
      data-worktree-card-frame-needs-input=""
      role="img"
      aria-label={translate('auto.components.sidebar.WorktreeCard.frameNeedsInput', 'Needs input')}
    />
  )
}
