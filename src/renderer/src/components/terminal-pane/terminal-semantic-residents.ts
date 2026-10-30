import { TerminalResidentRegistry, type TerminalResident } from './terminal-resident-registry'
import type { createTerminalResidentPolicy } from './terminal-resident-policy'
import type { TerminalResidentLegacySource } from './terminal-resident-legacy-source'
import type { TerminalResidentBinding } from './terminal-resident-binding'

export type TerminalSemanticResident = TerminalResident<
  ReturnType<typeof createTerminalResidentPolicy>
>
export const residentRegistry = new TerminalResidentRegistry<
  ReturnType<typeof createTerminalResidentPolicy>
>()
export const sourceSubscriptionsByPtyId = new Map<
  string,
  {
    close?: () => void
    endpoint?: string | null
    tabId?: string
    paneKey?: string
    binding?: TerminalResidentBinding
  }
>()
export const residentsByPtyId = new Map<string, TerminalSemanticResident>()
export const legacySourcesByPtyId = new Map<
  string,
  {
    resident: TerminalSemanticResident
    source: TerminalResidentLegacySource
    unsubscribe?: () => void
    installationSource?: object
  }
>()

export function disposeLegacySource(ptyId: string): void {
  const legacy = legacySourcesByPtyId.get(ptyId)
  if (!legacy) {
    return
  }
  legacySourcesByPtyId.delete(ptyId)
  legacy.unsubscribe?.()
}

export function getTerminalSemanticResident(ptyId: string): TerminalSemanticResident | undefined {
  return residentsByPtyId.get(ptyId)
}

export function retireCapturedResident(resident: TerminalSemanticResident): void {
  if (residentsByPtyId.get(resident.identity.ptyId) !== resident) {
    return
  }
  residentsByPtyId.delete(resident.identity.ptyId)
  sourceSubscriptionsByPtyId.get(resident.identity.ptyId)?.close?.()
  sourceSubscriptionsByPtyId.delete(resident.identity.ptyId)
  disposeLegacySource(resident.identity.ptyId)
  residentRegistry.retire(resident)
}

export function retireTerminalSemanticResident(ptyId: string, incarnationId?: string): void {
  const resident = residentsByPtyId.get(ptyId)
  if (!resident && incarnationId === undefined) {
    sourceSubscriptionsByPtyId.get(ptyId)?.close?.()
    sourceSubscriptionsByPtyId.delete(ptyId)
  }
  if (
    !resident ||
    (incarnationId !== undefined && resident.identity.incarnationId !== incarnationId)
  ) {
    return
  }
  retireCapturedResident(resident)
}

export function retireTerminalSemanticResidentsForTab(
  tabId: string,
  paneKeys?: ReadonlySet<string>
): void {
  // Resource removal cancels unresolved interest; physical exit alone retires admitted E.
  for (const [ptyId, source] of sourceSubscriptionsByPtyId) {
    if (
      !residentsByPtyId.has(ptyId) &&
      source.tabId === tabId &&
      (!paneKeys || (source.paneKey && paneKeys.has(source.paneKey)))
    ) {
      source.close?.()
      sourceSubscriptionsByPtyId.delete(ptyId)
    }
  }
}
