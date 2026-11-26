import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

/** A finished terminal worker's conversation log; what a click opens once its terminal is gone. */
export const ORCHESTRATION_WORKER_TRANSCRIPT_METHOD = 'orchestration.workerTranscript'

/** A path on the host that answered, as the worker's agent reported it. */
export type OrchestrationWorkerTranscript = { agent: TuiAgent; path: string }

export type OrchestrationWorkerTranscriptResult = {
  transcript: OrchestrationWorkerTranscript | null
}
