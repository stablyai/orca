export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function isSafeTimerDelayMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMER_DELAY_MS
  )
}

export function parsePositiveSafeIntegerText(raw: string): number | null {
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null
  }
  const exactValue = parseExactIntegerNumericText(trimmed)
  return exactValue === BigInt(value) ? value : null
}

// Why: mirrors the CLI's own `Number()` coercion for generic `--timeout-ms`
// flags (cli/flags.ts getOptionalPositiveIntegerFlag). Text that coerces to an
// exact integer — `1000.0`, `600000.000000000000001` — is the budget the CLI
// will actually wait on, so rejecting it here would leave the caller's timer
// shorter than the CLI's and cut the request short. Callers that need exact
// text (orchestration ask) use parsePositiveSafeIntegerText instead.
export function parsePositiveSafeIntegerNumericText(raw: string): number | null {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseExactIntegerNumericText(raw: string): bigint | null {
  if (
    /^\+?0[xX][\da-fA-F]+$/.test(raw) ||
    /^\+?0[bB][01]+$/.test(raw) ||
    /^\+?0[oO][0-7]+$/.test(raw)
  ) {
    return BigInt(raw.startsWith('+') ? raw.slice(1) : raw)
  }
  const match = /^\+?(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(raw)
  if (!match) {
    return null
  }
  const [whole = '', fraction = ''] = match[1].split('.')
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0'
  const shift = Number(match[2] ?? 0) - fraction.length
  if (!Number.isSafeInteger(shift)) {
    return null
  }
  if (shift >= 0) {
    return BigInt(digits) * 10n ** BigInt(shift)
  }
  const removedDigits = -shift
  if (removedDigits > digits.length || !digits.endsWith('0'.repeat(removedDigits))) {
    return null
  }
  return BigInt(digits.slice(0, -removedDigits) || '0')
}
