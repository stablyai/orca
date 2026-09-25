// Why: runtime RPC results are cast, not decoded — `runtime-rpc-envelope` declares `result:
// z.unknown()` — so a host on a newer build routinely puts a discriminant on the wire that this
// build's union has never heard of, and a switch on it falls through to `undefined`.
//
// Callers pass a `Record<TheUnion, true>` so a new union member fails typecheck twice: on the Record
// (TS2741) and on the switch (`switch-exhaustiveness-check`, which forbids an absorbing `default:`).
//
// typeof first: `Object.hasOwn` coerces its key, so a host that widened the field to an array sends
// `['missing']`, which a hasOwn-only guard admits before the switch drops it straight back out.
export function isHandledWireDiscriminant<T extends string>(
  value: unknown,
  handled: Record<T, true>
): value is T {
  return typeof value === 'string' && Object.hasOwn(handled, value)
}
