export async function settlePipelineManagerRequest(
  action: () => Promise<void>,
  onError: (error: unknown) => void,
  onSettled: () => void
) {
  try {
    await action()
  } catch (error) {
    onError(error)
  } finally {
    onSettled()
  }
}
