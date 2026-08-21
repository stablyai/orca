import type { PtySourceDeliveryIdentity, PtySourceSpan } from './pty-source-credit-contract'
import {
  assertNonNegativeSafeInteger,
  assertPtySourceIdentity
} from './pty-source-credit-validation'

export type TerminalOutputSourceRange = Readonly<
  Omit<PtySourceSpan, 'data' | 'splittable' | 'indivisible'> & {
    splittable: boolean
  }
>

export function assertTerminalOutputSourceRange(range: TerminalOutputSourceRange): void {
  assertPtySourceIdentity(range)
  if (!range.spanId) {
    throw new Error('Terminal output source range requires a span ID')
  }
  assertNonNegativeSafeInteger(range.sourceStartSu, 'sourceStartSu')
  assertNonNegativeSafeInteger(range.sourceEndSu, 'sourceEndSu')
  assertNonNegativeSafeInteger(range.displayStart, 'displayStart')
  assertNonNegativeSafeInteger(range.displayEnd, 'displayEnd')
  assertNonNegativeSafeInteger(range.transform.rawLengthSu, 'rawLengthSu')
  if (
    range.sourceEndSu <= range.sourceStartSu ||
    range.displayEnd < range.displayStart ||
    range.sourceEndSu - range.sourceStartSu !== range.transform.rawLengthSu ||
    typeof range.splittable !== 'boolean' ||
    typeof range.transform.transformed !== 'boolean' ||
    typeof range.transform.scalarSafe !== 'boolean' ||
    (range.transform.transformed && range.splittable) ||
    (!range.transform.transformed &&
      range.sourceEndSu - range.sourceStartSu !== range.displayEnd - range.displayStart)
  ) {
    throw new Error('Terminal output source range is malformed')
  }
}

export function sameTerminalOutputSourceIdentity(
  left: PtySourceDeliveryIdentity,
  right: PtySourceDeliveryIdentity
): boolean {
  return (
    left.id === right.id &&
    left.providerGeneration === right.providerGeneration &&
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.deliveryToken === right.deliveryToken
  )
}
