import { PAIRING_INPUT_MAX_CHARACTERS } from './mobile-pairing-protocol-limits'

/** True for `orca://pair?...` launch arguments; the exact host keeps `orca://pairing` and others out. */
export function isPairingLinkArgument(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith('orca://pair')) {
    return false
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'orca:' && parsed.hostname === 'pair'
  } catch {
    return false
  }
}

export function pairingLinkFromArguments(argv: readonly string[]): string | null {
  const value = argv.find(isPairingLinkArgument)
  // Why one past the cap: an oversized link must still fail validation in the dialog, not be trimmed valid.
  return value ? value.trim().slice(0, PAIRING_INPUT_MAX_CHARACTERS + 1) : null
}
