/**
 * Which panes main's legacy relay bridge serves, known before those panes mount.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import type { LegacyRelayBridgedPane } from '../../../../shared/legacy-relay-bridge-contract'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'

let panes: LegacyRelayBridgedPane[] = []
const listeners = new Set<() => void>()
/** Which pane (tab and leaf) holds each bridged PTY; a second pane never drives the same shell. */
const claims = new Map<string, string>()
let subscribed = false
let firstListing: Promise<void> = Promise.resolve()

function ensureSubscribed(): void {
  const api = typeof window === 'undefined' ? undefined : window.api?.legacyRelayBridge
  if (subscribed || !api) {
    return
  }
  subscribed = true
  const apply = (next: LegacyRelayBridgedPane[]): void => {
    panes = Array.isArray(next) ? next : []
    for (const ptyId of claims.keys()) {
      if (!panes.some((pane) => pane.ptyId === ptyId)) {
        claims.delete(ptyId)
      }
    }
    listeners.forEach((listener) => listener())
  }
  api.onPanes(apply)
  firstListing = api.listPanes().then(apply, () => {})
}

/** Settles once main's first pane list arrived, so a close never reads the empty initial cache. */
export function legacyRelayBridgedPanesListed(): Promise<void> {
  ensureSubscribed()
  return firstListing
}

ensureSubscribed()

export function legacyRelayBridgedPane(ptyId: string): LegacyRelayBridgedPane | undefined {
  ensureSubscribed()
  return panes.find((pane) => pane.ptyId === ptyId)
}

/** The bridged panes in a runtime tab, and the leaf a `web-terminal-<tab::leaf>` id names. */
function bridgedPanesInTab(
  tabId: string,
  leafId: string | null | undefined
): { inTab: LegacyRelayBridgedPane[]; leaf: string | null } {
  ensureSubscribed()
  if (!window.api?.legacyRelayBridge) {
    return { inTab: [], leaf: null }
  }
  // A tab mirrored from the managed server is `web-terminal-<tab>` or `web-terminal-<tab::leaf>`;
  // the lease names the relay-era tab and leaf it carried over.
  const [hostTabId, hostLeafId] = toHostSessionTabId(tabId).split(HOST_TERMINAL_SURFACE_SEPARATOR)
  return {
    inTab: panes.filter((pane) => pane.tabId === hostTabId),
    leaf: hostLeafId ?? leafId ?? null
  }
}

/** The bridged pane a runtime pane's tab and leaf name, if main serves one. */
function bridgedPaneFor(
  tabId: string,
  leafId: string | null | undefined
): LegacyRelayBridgedPane | undefined {
  const { inTab, leaf } = bridgedPanesInTab(tabId, leafId)
  // A lease without a leaf names its tab's pane only when it is that tab's sole bridged terminal.
  return (
    inTab.find((pane) => pane.leafId === (leaf ?? '') || pane.leafId === leafId) ??
    (inTab.length === 1 && !inTab[0].leafId ? inTab[0] : undefined)
  )
}

/**
 * Whether activating this tab on the managed server could reach a pane the bridge serves, which
 * would start a second shell there that no tab shows. Without a leaf, any bridged pane in the tab
 * counts: the server then picks a pane itself.
 */
export function isLegacyRelayBridgedTab(tabId: string, leafId?: string | null): boolean {
  const { inTab, leaf } = bridgedPanesInTab(tabId, leafId)
  return leaf === null ? inTab.length > 0 : bridgedPaneFor(tabId, leafId) !== undefined
}

/** Whether any pane in this tab is one the bridge serves. */
export function hasLegacyRelayBridgedPane(tabId: string): boolean {
  return bridgedPanesInTab(tabId, null).inTab.length > 0
}

/**
 * The bridged PTYs a closing tab runs: the panes main lists for its relay-era tab (only the named
 * leaf for a `tab::leaf` mirror), plus any bridged PTY the tab itself was bound to.
 */
export function legacyRelayBridgedPtyIdsForClosingTab(
  tabId: string,
  boundPtyIds: readonly string[]
): string[] {
  const { inTab, leaf } = bridgedPanesInTab(tabId, null)
  const named =
    leaf === null ? inTab : [bridgedPaneFor(tabId, null)].filter((pane) => pane !== undefined)
  const ids = new Set(named.map((pane) => pane.ptyId))
  for (const ptyId of boundPtyIds) {
    if (panes.some((pane) => pane.ptyId === ptyId)) {
      ids.add(ptyId)
    }
  }
  return [...ids]
}

/**
 * The relay-era PTY a runtime pane should reattach through the bridge: one main reports serving
 * for this tab and leaf, or the `ssh:` id the pane itself still names from an earlier bridging.
 */
export function legacyRelayBridgePtyIdForPane(args: {
  tabId: string
  leafId: string | null | undefined
  boundPtyId: string | null | undefined
}): string | null {
  if (!window.api?.legacyRelayBridge) {
    return null
  }
  const candidate =
    bridgedPaneFor(args.tabId, args.leafId)?.ptyId ??
    (args.boundPtyId && parseAppSshPtyId(args.boundPtyId) ? args.boundPtyId : null)
  if (!candidate) {
    return null
  }
  const claimant = paneClaimant(args.tabId, args.leafId)
  const holder = claims.get(candidate)
  if (holder && holder !== claimant) {
    return null
  }
  claims.set(candidate, claimant)
  return candidate
}

function paneClaimant(tabId: string, leafId: string | null | undefined): string {
  return `${tabId}\u0000${leafId ?? ''}`
}

/** Lets another pane (a converted row's) take a PTY this unmounting pane held. */
export function releaseLegacyRelayBridgePaneClaim(
  ptyId: string,
  tabId: string,
  leafId: string | null | undefined
): void {
  if (claims.get(ptyId) === paneClaimant(tabId, leafId)) {
    claims.delete(ptyId)
  }
}

/** The relay-era tabs holding a pane the bridge serves for this SSH target. */
export function legacyRelayBridgedTabIds(targetId: string): string[] {
  ensureSubscribed()
  return [...new Set(panes.filter((pane) => pane.targetId === targetId).map((p) => p.tabId))]
}

export function onLegacyRelayBridgedPanesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
