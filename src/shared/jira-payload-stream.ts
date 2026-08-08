export const JIRA_PAYLOAD_CHUNK_CHARS = 256 * 1024
export const JIRA_PAYLOAD_MAX_CHARS = 32 * 1024 * 1024

export type JiraPayloadStreamMessage = { type: 'chunk'; content: string } | { type: 'end' }

export function isJiraPayloadStreamMessage(value: unknown): value is JiraPayloadStreamMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false
  }
  const message = value as { type?: unknown; content?: unknown }
  return message.type === 'end' || (message.type === 'chunk' && typeof message.content === 'string')
}
