import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'

/** Use two blocks: balancing one wrapped string leaves a gap in the pre-sized tooltip. */
export function ResumeInNewCliTooltipText(): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <span className="block">
        {t(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCliTooltipFork',
          'Start a new terminal agent session with a copy of this conversation.'
        )}
      </span>
      <span className="block">
        {t(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCliTooltipChat',
          'This chat stays unchanged.'
        )}
      </span>
    </>
  )
}
