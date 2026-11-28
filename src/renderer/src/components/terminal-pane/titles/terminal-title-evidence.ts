import { normalizeCompatibleAgentTitleForOwner } from '../../../../../shared/agent-status/title/agent-title-owner'
import {
  isNormalizedAgentTitleStamp,
  normalizeTerminalTitle
} from '../../../../../shared/agent-status/title/agent-title-status'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'

/** Normalize display title using resolved compatible ownership instead of raw wrapper text. */
export function resolvePaneDisplayTitle(
  title: string,
  ownerAgentType: AgentType | null | undefined,
  ownerIsLaunch = false
): string {
  return normalizeCompatibleAgentTitleForOwner(title, ownerAgentType, { ownerIsLaunch })
}

/** One interpretation feeds tab/pane labels and completion tracking for each OSC title. */
export type PaneTitleDecision = {
  displayTitle: string
  rawTitle: string
}

export type ResolvePaneTitleDecisionInput = {
  /** Normalized title from the transport (may already be display-shaped). */
  normalizedTitle: string
  rawTitle: string
  /** Owner used for the display label — may include sticky/tab-scoped launch
   *  identity, which is correct for the visible label. */
  displayOwnerAgentType: AgentType | null | undefined
  /** True when displayOwnerAgentType is user-selected launch ownership. */
  displayOwnerIsLaunch?: boolean
}

export function resolvePaneTitleDecision(input: ResolvePaneTitleDecisionInput): PaneTitleDecision {
  // Actual raw evidence can disprove an old producer's destructive display stamp.
  const displayInput =
    isNormalizedAgentTitleStamp(input.normalizedTitle) &&
    resolveExplicitTerminalTitleAgentType(input.rawTitle) !==
      resolveExplicitTerminalTitleAgentType(input.normalizedTitle)
      ? normalizeTerminalTitle(input.rawTitle)
      : input.normalizedTitle
  const displayTitle = resolvePaneDisplayTitle(
    displayInput,
    input.displayOwnerAgentType,
    input.displayOwnerIsLaunch === true
  )
  return { displayTitle, rawTitle: input.rawTitle }
}
