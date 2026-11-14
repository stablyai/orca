type WebAgentSessionHandoff = {
  environmentId: string
  worktreeId: string
  provisionalTabId: string
  hostTabId: string
  hostTerminalHandle: string
}

type WebAgentSessionHandoffKey = Pick<
  WebAgentSessionHandoff,
  'environmentId' | 'worktreeId' | 'provisionalTabId'
>

type WebAgentSessionHandoffState = {
  hostTabId: string
  hostTerminalHandle: string
  postCreateSnapshotConfirmed: boolean
}

const handoffByProvisionalTab = new Map<string, WebAgentSessionHandoffState>()
export const MAX_WEB_AGENT_SESSION_HANDOFFS = 512

function handoffKey(args: WebAgentSessionHandoffKey): string {
  return `${args.environmentId}\0${args.worktreeId}\0${args.provisionalTabId}`
}

export function recordWebAgentSessionHandoff(args: WebAgentSessionHandoff): void {
  if (
    !args.environmentId.trim() ||
    !args.worktreeId.trim() ||
    !args.provisionalTabId.trim() ||
    !args.hostTabId.trim() ||
    !args.hostTerminalHandle.trim()
  ) {
    return
  }
  const key = handoffKey(args)
  handoffByProvisionalTab.delete(key)
  handoffByProvisionalTab.set(key, {
    hostTabId: args.hostTabId,
    hostTerminalHandle: args.hostTerminalHandle,
    postCreateSnapshotConfirmed: false
  })
  while (handoffByProvisionalTab.size > MAX_WEB_AGENT_SESSION_HANDOFFS) {
    const oldest = handoffByProvisionalTab.keys().next()
    if (oldest.done || oldest.value === key) {
      break
    }
    handoffByProvisionalTab.delete(oldest.value)
  }
}

export function resolveWebAgentSessionHandoff(args: WebAgentSessionHandoffKey): string | null {
  return handoffByProvisionalTab.get(handoffKey(args))?.hostTabId ?? null
}

export function isWebAgentSessionHandoffPostCreateSnapshotConfirmed(
  args: WebAgentSessionHandoffKey
): boolean {
  return handoffByProvisionalTab.get(handoffKey(args))?.postCreateSnapshotConfirmed === true
}

export function confirmWebAgentSessionHandoffAfterCreate(args: WebAgentSessionHandoff): void {
  const key = handoffKey(args)
  const handoff = handoffByProvisionalTab.get(key)
  if (
    handoff?.hostTabId === args.hostTabId &&
    handoff.hostTerminalHandle === args.hostTerminalHandle
  ) {
    handoffByProvisionalTab.set(key, { ...handoff, postCreateSnapshotConfirmed: true })
  }
}

export function clearWebAgentSessionHandoff(args: WebAgentSessionHandoffKey): void {
  handoffByProvisionalTab.delete(handoffKey(args))
}

export function clearWebAgentSessionHandoffsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const prefix = `${environmentId}\0${worktreeId}\0`
  for (const key of handoffByProvisionalTab.keys()) {
    if (key.startsWith(prefix)) {
      handoffByProvisionalTab.delete(key)
    }
  }
}

export function clearWebAgentSessionHandoffsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of handoffByProvisionalTab.keys()) {
    if (key.startsWith(prefix)) {
      handoffByProvisionalTab.delete(key)
    }
  }
}

export function resetWebAgentSessionHandoffsForTests(): void {
  handoffByProvisionalTab.clear()
}
