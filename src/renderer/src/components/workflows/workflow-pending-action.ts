/** Holds a pending flag across async work; lives outside components so React Compiler can compile them. */
export async function runWhilePending(
  setPending: (pending: boolean) => void,
  work: () => Promise<void>
): Promise<void> {
  setPending(true)
  try {
    await work()
  } finally {
    setPending(false)
  }
}
