import { getPluginHostMethodSpec } from '../workers/plugin-host-api'
import type { PluginCapabilityKind } from './plugin-capabilities'
import type { PluginSurface } from '../frames/plugin-protocol'

/**
 * The capability gate — pure, electron-free, shared by the Electron main
 * host, the headless serve RPC path, and the relay so a security decision
 * cannot land on desktop while drifting on the remote path. Deny-by-default:
 * an empty capability set grants nothing. A conformance test runs identical
 * cases against the desktop and relay enforcement surfaces.
 *
 * Ported from community PR #5801's electron-free gate, rekeyed to the host
 * API 1 spec table.
 */

export type PluginGateErrorCode =
  | 'unknown_method'
  | 'capability_denied'
  | 'consent_required'
  | 'not_permitted'

export type PluginGateDecision =
  | { granted: true }
  | { granted: false; code: PluginGateErrorCode; error: string }

export type PluginGateSubject = {
  /** Null for unknown/invalid/disabled plugins or missing/stale consent. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  /** Frames (panels, editors) have fewer callable methods than workers. */
  surface: PluginSurface
}

export function gatePluginHostCall(subject: PluginGateSubject, method: string): PluginGateDecision {
  const spec = getPluginHostMethodSpec(method)
  if (!spec) {
    return { granted: false, code: 'unknown_method', error: `unknown host method: ${method}` }
  }
  if (!spec.surfaces.includes(subject.surface)) {
    return {
      granted: false,
      code: 'not_permitted',
      error: `method ${method} is not available to plugin ${subject.surface}s`
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
