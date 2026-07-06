import { isGeminiTerminalTitle } from '@/lib/agent-status'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/types'

export type TerminalGpuAccelerationMode = GlobalSettings['terminalGpuAcceleration']

/**
 * The resolved renderer decision for a pane. `gpuEnabled` is the content-compat
 * gate passed to `setPaneGpuRendering`; the user-setting mode gate and WebGL
 * capability/context-loss latches are still applied downstream by the pane
 * manager, so this decision never has to force WebGL on when it is unavailable.
 */
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

// Why: an authoritative non-Gemini owner (OMP, Pi, Claude, a shell, …) outranks
// raw title text. 'unknown' is not authoritative, so it does not veto the
// title-derived Gemini fallback.
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

// Why: keep the existing title-driven Gemini fallback, but let owner evidence
// veto it so a Pi/OMP pane whose cwd or session text mentions gemini is never
// forced onto the DOM renderer.
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

/**
 * Resolves the pane renderer (WebGL vs DOM content gate) from the user GPU
 * setting, WebGL capability/context-loss state, and owner/title evidence.
 *
 * Precedence: user `off` keeps the effective renderer on DOM downstream while
 * leaving the content gate open for a later mode switch; WebGL
 * unavailable/context-loss force DOM; explicit `on` keeps GPU regardless of
 * agent compatibility; `auto` applies the Gemini compatibility fallback only
 * when owner evidence does not attribute the pane to another agent/shell.
 */
export function resolvePaneRendererPolicy(
  input: ResolvePaneRendererPolicyInput
): RendererPolicyDecision {
  const { rawTitle, ownerAgentType, userGpuMode } = input

  if (userGpuMode === 'off') {
    // Why: the user-setting mode gate downstream already forces DOM. Mirror the
    // title/owner content gate so a genuine Gemini pane stays DOM-gated while
    // other panes keep the gate open for a later switch to `auto`/`on`.
    const fallback = resolveGeminiCompatFallback(rawTitle, ownerAgentType)
    // Why: carry the fallback's own confidence so identical inputs report the
    // same confidence whether the effective mode is `off` or `auto`.
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
