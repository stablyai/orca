export type NativeChatStopAvailability = {
  targetWritable: boolean
  stopCommandAvailable: boolean
}

/** Stop is actionable only when it can reach a live target and has a command to dispatch. */
export function canStopNativeChatAgent({
  targetWritable,
  stopCommandAvailable
}: NativeChatStopAvailability): boolean {
  return targetWritable && stopCommandAvailable
}
