/** The grant and the worker’s own project must both identify the same project. */
export function workerPreferenceLookup(projectId: string): string {
  return `For a recurring project choice, use commander_ask_preference if that MCP tool is configured for this project. Pass projectId ${JSON.stringify(projectId)}, the exact question, and a requestId unique to this occurrence. Reuse that ID on retry. Apply a matched answer only to this question.`
}
