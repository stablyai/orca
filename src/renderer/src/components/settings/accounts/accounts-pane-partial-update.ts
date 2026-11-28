import type { ProviderAccountRuntimeView } from '../../provider-accounts/provider-account-visibility'

/** A multi-lane update that failed after earlier lanes applied; the runner still applies their result. */
export class PartialAccountUpdateError<T> extends Error {
  constructor(
    readonly applied: T,
    readonly appliedLanes: readonly ProviderAccountRuntimeView[],
    override readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

function isRuntimeList(
  value: ProviderAccountRuntimeView | readonly ProviderAccountRuntimeView[]
): value is readonly ProviderAccountRuntimeView[] {
  return Array.isArray(value)
}

export function toRuntimeList(
  value: ProviderAccountRuntimeView | readonly ProviderAccountRuntimeView[]
): readonly ProviderAccountRuntimeView[] {
  return isRuntimeList(value) ? value : [value]
}
