export type PtyDataSidecarDeliveryFailure = { error: unknown }

/** Delivers one chunk to a stable cohort and retains its first callback error. */
export function deliverPtyDataToSidecarCohort(
  sidecars: Iterable<(data: string) => void>,
  data: string
): PtyDataSidecarDeliveryFailure | null {
  let failure: PtyDataSidecarDeliveryFailure | null = null
  for (const sidecar of Array.from(sidecars)) {
    try {
      sidecar(data)
    } catch (error) {
      failure ??= { error }
    }
  }
  return failure
}
