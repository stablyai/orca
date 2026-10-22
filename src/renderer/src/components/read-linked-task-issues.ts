export async function readLinkedTaskIssuesWithLimit<TRef, TIssue>(
  refs: readonly TRef[],
  read: (ref: TRef) => Promise<TIssue | null>,
  concurrency = 6
): Promise<(TIssue | null)[]> {
  const results = Array.from({ length: refs.length }, (): TIssue | null => null)
  let nextIndex = 0
  const workerCount = Math.min(refs.length, Math.max(1, Math.floor(concurrency)))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < refs.length) {
        const index = nextIndex++
        results[index] = await read(refs[index])
      }
    })
  )
  return results
}
