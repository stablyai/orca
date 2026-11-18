import { record, type JsonRecord } from './codex-rollout-jsonl-format'
import { codexSubagentPathLabel } from './codex-agent-path'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

/** A child rollout's first line names the child even when its hooks only say `default`. */
export function codexSubagentIdentityFromHead(
  head: JsonRecord | undefined,
  agentId: string
): { description?: string } | undefined {
  const payload = record(head?.payload)
  if (head?.type !== 'session_meta' || payload?.id !== agentId) {
    return undefined
  }
  const spawn = record(record(record(payload.source)?.subagent)?.thread_spawn)
  return {
    description:
      codexSubagentPathLabel(text(spawn?.agent_path) ?? text(payload.agent_path) ?? null) ??
      text(spawn?.agent_nickname) ??
      text(payload.agent_nickname)
  }
}
