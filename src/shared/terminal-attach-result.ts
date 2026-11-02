export function terminalAttachResult<Result extends { id: string }>(result: Result) {
  return { ...result, isReattach: true }
}
