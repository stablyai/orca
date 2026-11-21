import { extname, isAbsolute } from 'node:path'
import { readJsonlFirstRecordAsync, type RolloutReadBatch } from './codex-rollout-async-reads'
import { readJsonlFirstRecord } from './codex-rollout-jsonl-cursor'
import { type JsonRecord, record } from './codex-rollout-jsonl-format'
import { codexSubagentPathLabel } from './codex-agent-path'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

export type CodexSubagentIdentity = { description?: string } | 'pending' | 'unreadable' | undefined

/** Only an absolute `.jsonl` rollout can carry a child's identity header. */
export function readsIdentity(transcriptPath: string): boolean {
  return isAbsolute(transcriptPath) && extname(transcriptPath) === '.jsonl'
}

function identityFromHead(
  head: JsonRecord | 'pending' | 'unreadable' | undefined,
  agentId: string
): CodexSubagentIdentity {
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

/** Immutable provider metadata names the child even when its parent emits no activity items. A string result says why it can't yet. */
export function readCodexSubagentIdentity(
  transcriptPath: string,
  agentId: string
): CodexSubagentIdentity {
  return readsIdentity(transcriptPath)
    ? identityFromHead(readJsonlFirstRecord(transcriptPath), agentId)
    : undefined
}

export async function readCodexSubagentIdentityAsync(
  transcriptPath: string,
  agentId: string,
  batch: RolloutReadBatch
): Promise<CodexSubagentIdentity> {
  return readsIdentity(transcriptPath)
    ? identityFromHead(await readJsonlFirstRecordAsync(transcriptPath, batch), agentId)
    : undefined
}
