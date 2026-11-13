export async function communityRequestResult<T>(
  operation: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown; message: string }> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error, message: error instanceof Error ? error.message : String(error) }
  }
}
