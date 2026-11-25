export function appendUniqueOpenFileIds(
  queue: string[],
  requestedFileIds: string[],
  openFileIds: ReadonlySet<string>
): string[] {
  if (requestedFileIds.length === 0) {
    return queue
  }
  const nextQueue = [...queue]
  for (const fileId of requestedFileIds) {
    if (!openFileIds.has(fileId)) {
      continue
    }
    if (nextQueue.includes(fileId)) {
      continue
    }
    nextQueue.push(fileId)
  }
  return nextQueue
}
