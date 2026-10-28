import { normalizeCompatibleAgentTitleForOwner } from '../../../../shared/agent-title-owner'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  resolvePaneRendererPolicy,
  type RendererPolicyDecision,
  type TerminalGpuAccelerationMode
} from './terminal-renderer-policy'

/** Normalize display title using resolved compatible ownership instead of raw wrapper text. */
export function resolvePaneDisplayTitle(
  title: string,
  ownerAgentType: AgentType | null | undefined,
  ownerIsLaunch = false
): string {
  return normalizeCompatibleAgentTitleForOwner(title, ownerAgentType, { ownerIsLaunch })
}

/** One interpretation feeds tab/pane labels, completion tracking and GPU policy for each OSC title. */
export type PaneTitleDecision = {
  displayTitle: string
  rawTitle: string
  rendererPolicy: RendererPolicyDecision
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
  /** GPU veto requires current pane ownership; sticky sibling/reused launch identity cannot hide genuine Gemini. */
  rendererOwnerAgentType: AgentType | null | undefined
  userGpuMode: TerminalGpuAccelerationMode
  webglUnavailable?: boolean
  inContextLossContainment?: boolean
}

export function resolvePaneTitleDecision(input: ResolvePaneTitleDecisionInput): PaneTitleDecision {
  const displayTitle = resolvePaneDisplayTitle(
    input.normalizedTitle,
    input.displayOwnerAgentType,
    input.displayOwnerIsLaunch === true
  )
  const rendererPolicy = resolvePaneRendererPolicy({
    rawTitle: input.rawTitle,
    ownerAgentType: input.rendererOwnerAgentType,
    userGpuMode: input.userGpuMode,
    webglUnavailable: input.webglUnavailable,
    inContextLossContainment: input.inContextLossContainment
  })
  return { displayTitle, rawTitle: input.rawTitle, rendererPolicy }
}
