import { getPluginHostMethodSpec, isPluginPanelAction } from './plugin-host-api'
import type { PluginCapabilityKind } from './plugin-capabilities'

/**
 * The capability gate — pure, electron-free, shared by the Electron main
 * host, the headless serve RPC path, and the relay so a security decision
 * cannot land on desktop while drifting on the remote path. Deny-by-default:
 * an empty capability set grants nothing. A conformance test runs identical
 * cases against the desktop and relay enforcement surfaces.
 *
 * Ported from community PR #5801's electron-free gate, rekeyed to the host
 * API v0 spec table.
 */

export type PluginGateErrorCode =
  | 'unknown_method'
  | 'capability_denied'
  | 'consent_required'
  | 'panel_forbidden'

export type PluginGateDecision =
  | { granted: true }
  | { granted: false; code: PluginGateErrorCode; error: string }

export type PluginGateSubject = {
  /** Capability kinds from the manifest the user consented to; null when the
   *  plugin is unknown, invalid, disabled, or consent is missing/stale. */
  grantedCapabilities: readonly PluginCapabilityKind[] | null
  /** True when the call arrives over the sandboxed panel bridge (narrower
   *  method surface than workers). */
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
  // Why: a disabled/unknown/stale-consent plugin must fail exactly like an
  // ungranted capability — no probe-able distinction for plugin code.
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
