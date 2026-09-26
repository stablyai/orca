import {
  getTerminalUrlOrcaBrowserHint,
  getTerminalUrlSystemBrowserHint
} from '@/components/terminal-pane/terminal-link-open-hints'

/**
 * Where a click on a port row lands: Orca's embedded browser, the system browser, or —
 * for users who inverted the modifier — the other way round. Kept apart from the port
 * actions themselves because every ports surface needs the decision and the matching
 * tooltip, while only some of them open anything.
 */
export function shouldOpenWorkspacePortInOrcaBrowser(
  settings: { openLinksInApp?: boolean } | null | undefined
): boolean {
  return settings?.openLinksInApp === true
}

/** Where Shift+Cmd/Ctrl+click on a port lands, or null when it has nothing to offer. */
export type PortOpenModifierDestination = 'system-browser' | 'orca' | null

type PortLinkRoutingSettings = {
  openLinksInApp?: boolean
  openLinksInAppModifierInverts?: boolean
}

export type PortOpenRoutingInputs = {
  settings: PortLinkRoutingSettings | null | undefined
  /** True when the listener lives on a paired remote host. Such a port has no URL this
   *  machine can dial on the default path, so a plain click always lands in Orca's
   *  embedded browser whatever Link Routing says. */
  remoteHost?: boolean
  /** Whether a client-reachable URL exists for the system browser to open. Always true
   *  for a local port; false for a remote one with no nameable address. */
  systemBrowserAvailable?: boolean
}

/** Where a plain (unmodified) click on this port lands. */
function plainClickDestination(inputs: PortOpenRoutingInputs): 'orca' | 'system-browser' {
  if (inputs.remoteHost === true) {
    return 'orca'
  }
  return shouldOpenWorkspacePortInOrcaBrowser(inputs.settings) ? 'orca' : 'system-browser'
}

/**
 * The modifier always names the destination a plain click does *not* reach, mirroring
 * resolveChecksPanelHostedReviewModifierDestination. Two consequences worth stating: on a
 * remote port the modifier means the system browser even for users who inverted it,
 * because inverting means "the other one" and the other one there is never Orca; and with
 * Link Routing off on a local port both meanings coincide, so there is no gesture to
 * advertise unless inverting is what brings the page back into Orca.
 */
export function resolvePortOpenModifierDestination(
  inputs: PortOpenRoutingInputs
): PortOpenModifierDestination {
  if (plainClickDestination(inputs) === 'orca') {
    return inputs.systemBrowserAvailable === false ? null : 'system-browser'
  }
  return inputs.settings?.openLinksInAppModifierInverts === true ? 'orca' : null
}

export function getPortOpenBrowserTooltipLabel(
  openLabel: string,
  options: { isMac?: boolean; modifierDestination?: PortOpenModifierDestination } = {}
): string {
  const destination =
    options.modifierDestination === undefined ? 'system-browser' : options.modifierDestination
  if (destination === null) {
    return openLabel
  }
  const hint =
    destination === 'orca'
      ? getTerminalUrlOrcaBrowserHint(options.isMac)
      : getTerminalUrlSystemBrowserHint(options.isMac)
  return `${openLabel}. ${hint}`
}

type PortOpenClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export type PortOpenRouting = {
  /** Whether this open should land in Orca's embedded browser. */
  openInOrcaBrowser: boolean
  /** True only when the user explicitly asked for the system browser with the modifier.
   *  Distinct from `openInOrcaBrowser === false`, which is also the stock-settings plain
   *  click — a remote port must not leave Orca just because Link Routing is off. */
  systemBrowserRequested: boolean
}

function isPortSystemBrowserModifier(event: PortOpenClickEvent, isMac: boolean): boolean {
  return event.shiftKey && (isMac ? event.metaKey : event.ctrlKey)
}

export function resolvePortOpenRouting(
  args: PortOpenRoutingInputs & { event?: PortOpenClickEvent | null; isMac: boolean }
): PortOpenRouting {
  const plain = {
    openInOrcaBrowser: shouldOpenWorkspacePortInOrcaBrowser(args.settings),
    systemBrowserRequested: false
  }
  // Why: Shift+Cmd/Ctrl is the escape hatch; no pointer event means context-menu and
  // keyboard opens should keep the saved setting.
  if (!args.event || !isPortSystemBrowserModifier(args.event, args.isMac)) {
    return plain
  }
  // The gesture does exactly what the tooltip promised — including nothing extra when
  // both destinations coincide.
  switch (resolvePortOpenModifierDestination(args)) {
    case 'system-browser':
      return { openInOrcaBrowser: false, systemBrowserRequested: true }
    case 'orca':
      return { openInOrcaBrowser: true, systemBrowserRequested: false }
    case null:
      return plain
  }
}

export function resolvePortOpenInOrcaBrowser(
  args: PortOpenRoutingInputs & { event?: PortOpenClickEvent | null; isMac: boolean }
): boolean {
  return resolvePortOpenRouting(args).openInOrcaBrowser
}
