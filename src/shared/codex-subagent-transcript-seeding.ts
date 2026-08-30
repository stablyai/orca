import { extname, isAbsolute } from 'node:path'

import type { AgentSubagentSnapshot } from './agent-status-types'
import type { CodexSubagentTranscriptState } from './codex-subagent-transcript'

const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

export function seedCodexSubagentTranscriptFromSnapshot(
  state: CodexSubagentTranscriptState,
  snapshots: readonly (Pick<AgentSubagentSnapshot, 'id' | 'description' | 'startedAt' | 'model'> &
    Partial<Pick<AgentSubagentSnapshot, 'state'>>)[],
  transcriptPath?: string,
  options: { authoritative?: boolean } = {}
): void {
  const normalizedPath = transcriptPath?.trim()
  if (
    normalizedPath &&
    isAbsolute(normalizedPath) &&
    extname(normalizedPath) === '.jsonl' &&
    state.parent.filePath !== normalizedPath
  ) {
    state.parent = { filePath: normalizedPath, offset: 0, carry: '', coverageAuthoritative: false }
    state.subagents.clear()
    state.parentTerminalObserved = undefined
    state.parentReadable = undefined
  }
  if (options.authoritative) {
    state.parent.coverageAuthoritative = true
  }
  for (const snapshot of snapshots) {
    if (!SAFE_THREAD_ID.test(snapshot.id) || state.subagents.has(snapshot.id)) {
      continue
    }
    state.subagents.set(snapshot.id, {
      offset: 0,
      carry: '',
      coverageAuthoritative: false,
      description: snapshot.description,
      model: snapshot.model,
      restoredState:
        snapshot.state === 'working' || snapshot.state === 'waiting' ? snapshot.state : undefined,
      restoredFromSnapshot: true,
      startedAt: Number.isFinite(snapshot.startedAt) ? snapshot.startedAt : Date.now()
    })
  }
}
