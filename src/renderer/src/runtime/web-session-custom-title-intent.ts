import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'

const CUSTOM_TITLE_INTENT_TTL_MS = 30_000

type CustomTitle = string | null

type CustomTitleIntent = {
  id: number
  previousTitle: CustomTitle
  intendedTitle: CustomTitle
  recordedAt: number
}

export type WebSessionCustomTitleIntentToken = {
  key: string
  id: number
}

export type WebSessionCustomTitleIntentHandle = {
  retarget: (hostTabId: string) => void
  cancel: () => void
}

const pendingCustomTitleByKey = new Map<string, CustomTitleIntent>()
let nextCustomTitleIntentId = 0

function customTitleIntentKey(
  owner: WebSessionIntentOwner,
  worktreeId: string,
  hostTabId: string
): string {
  return `${webSessionIntentOwnerKey(owner)}\0${worktreeId}\0${hostTabId}`
}

export function beginWebSessionCustomTitleIntent(args: {
  owner: WebSessionIntentOwner
  worktreeId: string
  tabId: string
  previousTitle: CustomTitle
  intendedTitle: CustomTitle | undefined
}): WebSessionCustomTitleIntentHandle | null {
  if (args.intendedTitle === undefined) {
    return null
  }
  let token = recordWebSessionCustomTitleIntent({
    owner: args.owner,
    worktreeId: args.worktreeId,
    hostTabId: isWebTerminalSurfaceTabId(args.tabId) ? toHostSessionTabId(args.tabId) : args.tabId,
    previousTitle: args.previousTitle,
    intendedTitle: args.intendedTitle
  })
  return {
    retarget: (hostTabId) => {
      token = rekeyWebSessionCustomTitleIntent(token, { ...args, hostTabId })
    },
    cancel: () => cancelWebSessionCustomTitleIntent(token)
  }
}

export function recordWebSessionCustomTitleIntent(args: {
  owner: WebSessionIntentOwner
  worktreeId: string
  hostTabId: string
  previousTitle: CustomTitle
  intendedTitle: CustomTitle
  now?: number
}): WebSessionCustomTitleIntentToken {
  const key = customTitleIntentKey(args.owner, args.worktreeId, args.hostTabId)
  const id = ++nextCustomTitleIntentId
  pendingCustomTitleByKey.set(key, {
    id,
    previousTitle: args.previousTitle,
    intendedTitle: args.intendedTitle,
    recordedAt: args.now ?? Date.now()
  })
  return { key, id }
}

export function rekeyWebSessionCustomTitleIntent(
  token: WebSessionCustomTitleIntentToken,
  args: { owner: WebSessionIntentOwner; worktreeId: string; hostTabId: string }
): WebSessionCustomTitleIntentToken {
  const nextKey = customTitleIntentKey(args.owner, args.worktreeId, args.hostTabId)
  if (nextKey === token.key) {
    return token
  }
  const intent = pendingCustomTitleByKey.get(token.key)
  if (intent?.id === token.id) {
    pendingCustomTitleByKey.delete(token.key)
    pendingCustomTitleByKey.set(nextKey, intent)
  }
  return { key: nextKey, id: token.id }
}

export function cancelWebSessionCustomTitleIntent(
  token: WebSessionCustomTitleIntentToken | null
): void {
  if (!token) {
    return
  }
  if (pendingCustomTitleByKey.get(token.key)?.id === token.id) {
    pendingCustomTitleByKey.delete(token.key)
  }
}

export function reconcileWebSessionCustomTitleIntent(args: {
  owner: WebSessionIntentOwner
  worktreeId: string
  hostTabId: string
  hostTitle: CustomTitle
  now: number
}): CustomTitle {
  const key = customTitleIntentKey(args.owner, args.worktreeId, args.hostTabId)
  const intent = pendingCustomTitleByKey.get(key)
  if (!intent) {
    return args.hostTitle
  }
  if (args.now - intent.recordedAt > CUSTOM_TITLE_INTENT_TTL_MS) {
    pendingCustomTitleByKey.delete(key)
    return args.hostTitle
  }
  if (args.hostTitle === intent.intendedTitle) {
    pendingCustomTitleByKey.delete(key)
    return args.hostTitle
  }
  if (args.hostTitle === intent.previousTitle) {
    return intent.intendedTitle
  }
  pendingCustomTitleByKey.delete(key)
  return args.hostTitle
}

export function clearWebSessionCustomTitleIntentsForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const ownerPrefix = `${webSessionIntentOwnerKey({ environmentId })}\0${worktreeId}\0`
  for (const key of pendingCustomTitleByKey.keys()) {
    if (key.startsWith(ownerPrefix)) {
      pendingCustomTitleByKey.delete(key)
    }
  }
}

export function resetWebSessionCustomTitleIntentsForTests(): void {
  pendingCustomTitleByKey.clear()
}
