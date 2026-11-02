// RPC result is z.unknown then cast, so newer hosts may send discriminants this switch cannot handle.
// Record<Union, true> plus exhaustive switches catches new members at compile time without an absorbing default.
// Check typeof first: hasOwn coerces [missing] into a handled string key that would still fall through the switch.
export function isHandledWireDiscriminant<T extends string>(
  value: unknown,
  handled: Record<T, true>
): value is T {
  return typeof value === 'string' && Object.hasOwn(handled, value)
}
