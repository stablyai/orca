export function shouldShowNativeChatWorking(args: {
  isConversation: boolean
  viewWorking: boolean
  hookWorking: boolean
  interrupted: boolean
}): boolean {
  const rawWorking = args.isConversation && (args.viewWorking || args.hookWorking)
  return rawWorking && !args.interrupted
}

export function shouldClearNativeChatWorkingSuppression(args: {
  viewWorking: boolean
  hookWorking: boolean
}): boolean {
  return !args.viewWorking && !args.hookWorking
}
