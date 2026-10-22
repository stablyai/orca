import type React from 'react'
import { translate } from '@/i18n/i18n'

/** Shared by the row menus and the details button, which offer the same fork. Two block lines, not
 *  one wrapped string: the tooltip balances wrapped text inside a box sized before balancing, which
 *  leaves a gap beside the shorter lines. */
export function ResumeInNewCliTooltipText(): React.JSX.Element {
  return (
    <>
      <span className="block">
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCliTooltipFork',
          'Start a new terminal agent session with a copy of this conversation.'
        )}
      </span>
      <span className="block">
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCliTooltipChat',
          'This chat stays unchanged.'
        )}
      </span>
    </>
  )
}
