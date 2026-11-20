export function shouldShowNativeChatWorking(args: {
  isConversation: boolean
  working: boolean
  interrupted: boolean
}): boolean {
  return args.isConversation && args.working && !args.interrupted
}

/** Release Stop suppression when work ends or a newer working epoch starts without an intervening ready state. */
export function shouldClearNativeChatWorkingSuppression(args: {
  working: boolean
  interrupted?: boolean
  /** Hook `stateStartedAt` for the current working epoch, when known. */
  workingEpoch?: number | null
  /** Previous observed working epoch; used to detect a new generation. */
  previousWorkingEpoch?: number | null
}): boolean {
  if (!args.working) {
    return true
  }
  // Stop and next-turn updates can coalesce without working ever becoming false.
  if (
    args.interrupted === true &&
    args.workingEpoch != null &&
    args.previousWorkingEpoch != null &&
    args.workingEpoch > args.previousWorkingEpoch
  ) {
    return true
  }
  return false
}
