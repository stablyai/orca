import type React from 'react'
import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'

/** Use two blocks: balancing one wrapped string leaves a gap in the pre-sized tooltip. */
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

export function SwitchToCliTooltipText({ agent }: { agent: AiVaultAgent }): React.JSX.Element {
  return (
    <>
      {translate(
        'components.tab.bar.switch.toCliTooltip',
        'Switch to CLI: stops {{agent}} in Chat UI and continues the same conversation in a terminal.',
        { agent: agentLabel(agent) }
      )}
    </>
  )
}
