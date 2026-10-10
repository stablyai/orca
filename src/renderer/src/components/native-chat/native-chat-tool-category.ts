import {
  nativeChatToolCategory as sharedCategory,
  nativeChatToolIconName as sharedIconName,
  nativeChatToolRunIconName as sharedRunIconName
} from '../../../../shared/native-chat-tool-icon'
import { nativeChatToolRunClauses as sharedRunClauses } from '../../../../shared/native-chat-tool-run-sentence'
import type { NativeChatMcpIdentity } from '../../../../shared/native-chat-tool-identity'

type CategoryCall = { name: string; mcpIdentity?: NativeChatMcpIdentity }

// Agent is the transcript alias of Task; keep desktop rows and headers in agreement.
function categoryName(name: string): string {
  return name.trim().toLowerCase() === 'agent' ? 'Task' : name
}

function categoryCalls(calls: readonly CategoryCall[]): CategoryCall[] {
  return calls.map((call) => ({ ...call, name: categoryName(call.name) }))
}

export function nativeChatToolCategory(name: string, identity?: NativeChatMcpIdentity) {
  return sharedCategory(categoryName(name), identity)
}

export function nativeChatToolIconName(name: string, identity?: NativeChatMcpIdentity) {
  return sharedIconName(categoryName(name), identity)
}

export function nativeChatToolRunIconName(calls: readonly CategoryCall[]) {
  return sharedRunIconName(categoryCalls(calls))
}

export function nativeChatToolRunClauses(calls: readonly CategoryCall[]) {
  return sharedRunClauses(categoryCalls(calls))
}
