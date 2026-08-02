import { normalizeCompatibleAgentTitleForOwner } from '../../../../shared/agent-title-owner'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  resolvePaneRendererPolicy,
  type RendererPolicyDecision,
  type TerminalGpuAccelerationMode
} from './terminal-renderer-policy'

/**
 * Owner-aware display label. Wraps the compatible-owner title normalization so
 * the display label follows the resolved owner rather than raw wrapper text.
 */
export function resolvePaneDisplayTitle(
  title: string,
  ownerAgentType: AgentType | null | undefined
): string {
  return normalizeCompatibleAgentTitleForOwner(title, ownerAgentType)
}

/**
 * The resolved decision for one OSC title frame: a single owner-aware display
 * label plus the renderer policy, so `updateTabTitle`, `setRuntimePaneTitle`,
 * task-completion tracking, and the GPU gate all consume one interpretation.
 */
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
  /** Owner used for the renderer veto — must be pane-scoped and current so a
   *  sibling/reused pane's launch identity cannot keep GPU for a genuine
   *  Gemini pane. */
  rendererOwnerAgentType: AgentType | null | undefined
  userGpuMode: TerminalGpuAccelerationMode
  webglUnavailable?: boolean
  inContextLossContainment?: boolean
}

export function resolvePaneTitleDecision(input: ResolvePaneTitleDecisionInput): PaneTitleDecision {
  const displayTitle = resolvePaneDisplayTitle(input.normalizedTitle, input.displayOwnerAgentType)
  const rendererPolicy = resolvePaneRendererPolicy({
    rawTitle: input.rawTitle,
    ownerAgentType: input.rendererOwnerAgentType,
    userGpuMode: input.userGpuMode,
    webglUnavailable: input.webglUnavailable,
    inContextLossContainment: input.inContextLossContainment
  })
  return { displayTitle, rawTitle: input.rawTitle, rendererPolicy }
}
