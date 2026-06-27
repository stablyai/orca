import { isTailnetIPv4Address } from '../../../../shared/tailnet-address'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'

export type MobileNetworkInterface = {
  name: string
  address: string
}

export type ComboboxEntry =
  | { kind: 'interface'; iface: MobileNetworkInterface }
  | { kind: 'use-query'; address: string }

// Why: the UI needs a single ordered list to render inside CommandList.
// Behavior branches on whether the query parses as a valid address —
// valid queries show the full interface list (so users can pivot to an
// existing interface mid-typing), invalid queries substring-filter and
// fall back to the full list when nothing matches.
export function buildComboboxEntries(
  interfaces: readonly MobileNetworkInterface[],
  query: string
): readonly ComboboxEntry[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    return interfaces.map((iface) => ({ kind: 'interface' as const, iface }))
  }

  const parsed = parseManualNetworkAddress(trimmed)

  let visible: readonly MobileNetworkInterface[]
  if (parsed.ok) {
    // Valid address: keep every interface visible.
    visible = interfaces
  } else {
    // Invalid: substring-filter; fall back to full list when nothing matches.
    const lowered = trimmed.toLowerCase()
    const filtered = interfaces.filter(
      (iface) =>
        iface.address.toLowerCase().includes(lowered) || iface.name.toLowerCase().includes(lowered)
    )
    visible = filtered.length > 0 ? filtered : interfaces
  }

  const entries: ComboboxEntry[] = visible.map((iface) => ({
    kind: 'interface' as const,
    iface
  }))

  if (parsed.ok && !visible.some((iface) => iface.address === parsed.address)) {
    entries.push({ kind: 'use-query', address: parsed.address })
  }

  return entries
}

export function selectRefreshedNetworkAddress(
  currentAddress: string | undefined,
  interfaces: readonly MobileNetworkInterface[]
): string | undefined {
  if (interfaces.length === 0) {
    return undefined
  }
  if (currentAddress && interfaces.some((iface) => iface.address === currentAddress)) {
    return currentAddress
  }
  return (
    interfaces.find((iface) => isTailnetIPv4Address(iface.address))?.address ??
    interfaces[0]!.address
  )
}
