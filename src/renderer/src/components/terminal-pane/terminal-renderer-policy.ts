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
  reason: 'user-setting' | 'capability' | 'context-loss'
  // Why: the title-derived Gemini fallback was the only non-authoritative path.
  confidence: 'authoritative'
}

export type ResolvePaneRendererPolicyInput = {
  userGpuMode: TerminalGpuAccelerationMode
  /** Set when the pane cannot obtain a WebGL context at all. */
  webglUnavailable?: boolean
  /** Set when the pane is inside GPU crash/context-loss containment. */
  inContextLossContainment?: boolean
}

/**
 * Resolves the pane renderer (WebGL vs DOM content gate) from the user GPU
 * setting and WebGL capability/context-loss state.
 *
 * Precedence: user `off` keeps the effective renderer on DOM downstream while
 * leaving the content gate open for a later mode switch; WebGL
 * unavailable/context-loss force DOM; `on`/`auto` keep GPU.
 */
export function resolvePaneRendererPolicy(
  input: ResolvePaneRendererPolicyInput
): RendererPolicyDecision {
  if (input.userGpuMode === 'off') {
    // Why: the mode gate downstream already forces DOM, so leave the content
    // gate open for a later switch to `auto`/`on`.
    return { gpuEnabled: true, reason: 'user-setting', confidence: 'authoritative' }
  }
  if (input.inContextLossContainment) {
    return { gpuEnabled: false, reason: 'context-loss', confidence: 'authoritative' }
  }
  if (input.webglUnavailable) {
    return { gpuEnabled: false, reason: 'capability', confidence: 'authoritative' }
  }
  if (input.userGpuMode === 'on') {
    return { gpuEnabled: true, reason: 'user-setting', confidence: 'authoritative' }
  }
  return { gpuEnabled: true, reason: 'capability', confidence: 'authoritative' }
}
