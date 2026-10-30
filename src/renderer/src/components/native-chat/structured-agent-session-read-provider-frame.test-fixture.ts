import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

export function providerFrame(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      text: id,
      providerFrame: {
        provider: 'codex',
        kind: 'notification:item/commandExecution/outputDelta',
        payload: { head: id, byteLength: id.length, digest: id, truncated: false }
      }
    }
  }
}
