import {
  parseDismissedSubagentStatesJson,
  type DismissedSubagentStates
} from '../../../../shared/native-chat/input/native-chat-subagent-dismissals'

const PREFIX = 'orca:dismissedSubagents:v1:'

export function nativeChatDismissedSubagentsKey(sessionId: string): string {
  return `${PREFIX}${encodeURIComponent(sessionId)}`
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function readDismissedSubagents(sessionId: string | null): DismissedSubagentStates {
  if (!sessionId) {
    return {}
  }
  const store = storage()
  if (!store) {
    return {}
  }
  try {
    return parseDismissedSubagentStatesJson(
      store.getItem(nativeChatDismissedSubagentsKey(sessionId))
    )
  } catch {
    return {}
  }
}

export function writeDismissedSubagents(
  sessionId: string | null,
  dismissed: DismissedSubagentStates
): void {
  if (!sessionId) {
    return
  }
  const store = storage()
  if (!store) {
    return
  }
  const key = nativeChatDismissedSubagentsKey(sessionId)
  if (Object.keys(dismissed).length === 0) {
    store.removeItem(key)
    return
  }
  store.setItem(key, JSON.stringify(dismissed))
}
