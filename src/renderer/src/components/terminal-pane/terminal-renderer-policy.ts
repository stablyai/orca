import { isGeminiTerminalTitle } from '@/lib/agent-status'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export type TerminalGpuAccelerationMode = GlobalSettings['terminalGpuAcceleration']

/** Content compatibility gate only; PaneManager also enforces user mode, WebGL availability and context-loss containment. */
export type RendererPolicyDecision = {
  gpuEnabled: boolean
  reason: 'user-setting' | 'capability' | 'context-loss' | 'agent-compatibility'
  confidence: 'authoritative' | 'fallback'
}

export type ResolvePaneRendererPolicyInput = {
  rawTitle: string | null
  ownerAgentType: AgentType | null | undefined
  userGpuMode: TerminalGpuAccelerationMode
  /** Set when the pane cannot obtain a WebGL context at all. */
  webglUnavailable?: boolean
  /** Set when the pane is inside GPU crash/context-loss containment. */
  inContextLossContainment?: boolean
}

// Proven non-Gemini ownership overrides raw title text; unknown ownership cannot veto title fallback.
function isKnownNonGeminiOwner(ownerAgentType: AgentType | null | undefined): boolean {
  return (
    typeof ownerAgentType === 'string' &&
    ownerAgentType !== '' &&
    ownerAgentType !== 'gemini' &&
    ownerAgentType !== 'unknown'
  )
}

type GeminiCompatFallback = {
  disable: boolean
  confidence: 'authoritative' | 'fallback'
}

// Preserve Gemini title fallback unless current ownership proves another agent/shell.
function resolveGeminiCompatFallback(
  rawTitle: string | null,
  ownerAgentType: AgentType | null | undefined
): GeminiCompatFallback {
  if (!isGeminiTerminalTitle(rawTitle ?? '')) {
    return { disable: false, confidence: 'authoritative' }
  }
  if (isKnownNonGeminiOwner(ownerAgentType)) {
    return { disable: false, confidence: 'authoritative' }
  }
  return { disable: true, confidence: ownerAgentType === 'gemini' ? 'authoritative' : 'fallback' }
}

/** Resolve content policy while downstream enforces off. Unavailable/contained WebGL forces DOM; explicit on bypasses agent compatibility; auto uses Gemini fallback unless ownership vetoes it. */
export function resolvePaneRendererPolicy(
  input: ResolvePaneRendererPolicyInput
): RendererPolicyDecision {
  const { rawTitle, ownerAgentType, userGpuMode } = input

  if (userGpuMode === 'off') {
    // Off already forces DOM downstream; keep the content gate accurate for a later mode change.
    const fallback = resolveGeminiCompatFallback(rawTitle, ownerAgentType)
    // Retain fallback confidence consistently in off and auto modes.
    return {
      gpuEnabled: !fallback.disable,
      reason: 'user-setting',
      confidence: fallback.confidence
    }
  }

  if (input.inContextLossContainment) {
    return { gpuEnabled: false, reason: 'context-loss', confidence: 'authoritative' }
  }
  if (input.webglUnavailable) {
    return { gpuEnabled: false, reason: 'capability', confidence: 'authoritative' }
  }

  if (userGpuMode === 'on') {
    return { gpuEnabled: true, reason: 'user-setting', confidence: 'authoritative' }
  }

  const fallback = resolveGeminiCompatFallback(rawTitle, ownerAgentType)
  if (fallback.disable) {
    return { gpuEnabled: false, reason: 'agent-compatibility', confidence: fallback.confidence }
  }
  return { gpuEnabled: true, reason: 'capability', confidence: 'authoritative' }
}
