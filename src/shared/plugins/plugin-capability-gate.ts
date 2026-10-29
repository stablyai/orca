import { getPluginHostMethodSpec, isPluginPanelAction } from './plugin-host-api'
import type { PluginCapabilityKind } from './plugin-capabilities'

/** Shared Electron-free deny-by-default gate for desktop, serve and relay; conformance tests pin identical decisions.
 * Ported from community PR #5801 to the host API v0 table. */

export type PluginGateErrorCode =
  | 'unknown_method'
  | 'capability_denied'
  | 'consent_required'
  | 'panel_forbidden'

export type PluginGateDecision =
  | { granted: true }
  | { granted: false; code: PluginGateErrorCode; error: string }

export type PluginGateSubject = {
  /** Null for unknown/invalid/disabled plugins or missing/stale consent. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  /** Sandboxed panels have fewer callable methods than trusted workers. */
  viaPanel: boolean
}

export function gatePluginHostCall(subject: PluginGateSubject, method: string): PluginGateDecision {
  const spec = getPluginHostMethodSpec(method)
  if (!spec) {
    return { granted: false, code: 'unknown_method', error: `unknown host method: ${method}` }
  }
  if (subject.viaPanel && !isPluginPanelAction(method)) {
    return {
      granted: false,
      code: 'panel_forbidden',
      error: `method ${method} is not available to sandboxed panels`
    }
  }
  // Unknown, disabled and stale-consent plugins must be indistinguishable from ungranted capabilities.
  if (subject.grantedCapabilities === null) {
    return {
      granted: false,
      code: 'consent_required',
      error: 'plugin is not enabled with current consent'
    }
  }
  if (!subject.grantedCapabilities.includes(spec.capability)) {
    return {
      granted: false,
      code: 'capability_denied',
      error: `plugin does not have the "${spec.capability}" capability`
    }
  }
  return { granted: true }
}
