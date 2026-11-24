import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { extractAssistantContentText, parseTranscriptRecord } from '../../transcript-entry-text'

/** One per backward scan of a Copilot events.jsonl. It returns '' at the current turn's start, so
 *  the scan stops there instead of taking an earlier turn's reply while this one is unflushed. */
export class CopilotReplyLineReader {
  /** The scan passed a finished Fusion turn's end, so the replay lines before it are its answer. */
  private passedFusionCompletion = false

  readonly extract = (line: string): string | undefined => {
    const record = parseTranscriptRecord(line)
    // Copilot logs subagent events into the same events.jsonl, tagged with agentId.
    if (!record || record.agentId !== undefined) {
      return undefined
    }
    const data = isRecord(record.data) ? record.data : undefined
    switch (record.type) {
      // A Fusion repair turn starts at its handoff, which writes no user.message.
      case 'user.message':
      case 'session.fusion_handoff':
        return ''
      case 'session.fusion_completed':
        this.passedFusionCompletion = true
        return undefined
      // Fusion records the turn's answer on the solver phase after agentStop, then replays the
      // solver's turn (narration included) as `fusion`-tagged lines, ending in that same answer.
      case 'assistant.message':
        return data && (data.fusion === undefined || this.passedFusionCompletion)
          ? extractAssistantContentText(data.content)
          : undefined
      case 'assistant.fusion_phase_completed':
        return data?.role === 'solver' && data.status === 'succeeded'
          ? extractAssistantContentText(data.content)
          : undefined
      // Copilot autopilot's task_complete carries the turn's answer as its summary.
      case 'session.task_complete':
        return extractAssistantContentText(data?.summary)
    }
    return undefined
  }
}
