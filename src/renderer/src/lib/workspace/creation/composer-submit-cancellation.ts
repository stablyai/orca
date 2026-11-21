export type ComposerSubmitSettlement<T> =
  | { status: 'completed'; value: T }
  | { status: 'cancelled' }

export async function settleComposerSubmit<T>(
  promise: Promise<T>,
  isCancelled: () => boolean
): Promise<ComposerSubmitSettlement<T>> {
  try {
    const value = await promise
    return isCancelled() ? { status: 'cancelled' } : { status: 'completed', value }
  } catch (error) {
    if (isCancelled()) {
      return { status: 'cancelled' }
    }
    throw error
  }
}
