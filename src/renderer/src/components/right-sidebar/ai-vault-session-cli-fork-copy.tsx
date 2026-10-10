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
          'Forks this conversation into a new CLI session.'
        )}
      </span>
      <span className="block">
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCliTooltipChat',
          'The native chat stays as it is.'
        )}
      </span>
    </>
  )
}
