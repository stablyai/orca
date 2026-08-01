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
  handoffByProvisionalTab.set(handoffKey(args), {
    hostTabId: args.hostTabId,
    hostTerminalHandle: args.hostTerminalHandle,
    postCreateSnapshotConfirmed: false
  })
}

export function resolveWebAgentSessionHandoff(args: WebAgentSessionHandoffKey): string | null {
  return handoffByProvisionalTab.get(handoffKey(args))?.hostTabId ?? null
}

/** Environment-agnostic lookup: callers that only know the worktree (e.g. the
 * QuickLaunch prune) must still treat a handed-off provisional tab as live. */
export function hasWebAgentSessionHandoffForProvisionalTab(
  worktreeId: string,
  provisionalTabId: string
): boolean {
  const suffix = `\0${worktreeId}\0${provisionalTabId}`
  for (const key of handoffByProvisionalTab.keys()) {
    if (key.endsWith(suffix)) {
      return true
    }
  }
  return false
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
