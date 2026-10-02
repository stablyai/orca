import { observeAgentHookCompletionForNotification } from '../agent-hook-completion-notifications'

type CompletionPayload = Parameters<typeof observeAgentHookCompletionForNotification>[0]['payload']

export function applyAgentStatusCompletionNotification(args: {
  paneKey: string
  worktreeId: string | undefined
  payload: CompletionPayload
  stateStartedAt: number | undefined
  roomDeliveryId: string | undefined
  replay: boolean
}): void {
  if (!args.worktreeId || (args.replay && args.payload.state !== 'working')) {
    return
  }
  observeAgentHookCompletionForNotification({
    paneKey: args.paneKey,
    worktreeId: args.worktreeId,
    payload: {
      ...args.payload,
      ...(typeof args.stateStartedAt === 'number' ? { stateStartedAt: args.stateStartedAt } : {}),
      ...(args.roomDeliveryId ? { roomDeliveryId: args.roomDeliveryId } : {})
    },
    ...(args.replay ? { seedOnly: true } : {})
  })
}
