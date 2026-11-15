import { extname, isAbsolute } from 'node:path'
import { readJsonlFirstRecord, record } from './codex-rollout-jsonl-cursor'
import { codexSubagentPathLabel } from './codex-agent-path'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

/** Immutable provider metadata names the child even when its parent emits no activity items. A string result says why it can't yet. */
export function readCodexSubagentIdentity(
  transcriptPath: string,
  agentId: string
): { description?: string } | 'pending' | 'unreadable' | undefined {
  if (!isAbsolute(transcriptPath) || extname(transcriptPath) !== '.jsonl') {
    return undefined
  }
  const head = readJsonlFirstRecord(transcriptPath)
  if (head === 'pending' || head === 'unreadable') {
    return head
  }
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
