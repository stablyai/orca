/** The line a workflow worker ends its worker_done body with to hand back structured fields. */
export const WORKFLOW_RESULT_MARKER = 'WORKFLOW_RESULT:'

const MAX_RESULT_JSON_BYTES = 32_000

export type WorkflowWorkerReport = {
  outcome: 'succeeded' | 'failed'
  subject: string
  /** The report body with the WORKFLOW_RESULT line removed. */
  summary: string
  data: Record<string, unknown>
  /** Why data is empty when the node asked for JSON; null when parsing succeeded or was not asked. */
  dataError: string | null
  filesModified: string[]
  reportPath: string | null
  messageId: string | null
  completedAt: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Split a report body into its prose and the last WORKFLOW_RESULT object, treated as untrusted data. */
export function parseWorkflowResultBody(body: string): {
  summary: string
  data: Record<string, unknown>
  dataError: string | null
} {
  const lines = body.split(/\r?\n/)
  const markerIndex = lines.findLastIndex((line) =>
    line.trimStart().startsWith(WORKFLOW_RESULT_MARKER)
  )
  if (markerIndex === -1) {
    return { summary: body.trim(), data: {}, dataError: 'No WORKFLOW_RESULT line was reported.' }
  }
  const raw = lines[markerIndex].trimStart().slice(WORKFLOW_RESULT_MARKER.length).trim()
  const summary = lines
    .filter((_, index) => index !== markerIndex)
    .join('\n')
    .trim()
  if (raw.length > MAX_RESULT_JSON_BYTES) {
    return { summary, data: {}, dataError: 'WORKFLOW_RESULT exceeded 32 KB and was ignored.' }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed)
      ? { summary, data: parsed, dataError: null }
      : { summary, data: {}, dataError: 'WORKFLOW_RESULT must be a JSON object.' }
  } catch {
    return { summary, data: {}, dataError: 'WORKFLOW_RESULT was not valid JSON.' }
  }
}

/** Read the settlement Orca stored on the Task (lifecycle-reconciliation's worker_report record). */
export function parseWorkflowTaskResult(
  taskResult: string | null,
  fallbackOutcome: 'succeeded' | 'failed'
): WorkflowWorkerReport {
  let record: Record<string, unknown> = {}
  if (taskResult) {
    try {
      const parsed: unknown = JSON.parse(taskResult)
      record = isRecord(parsed) ? parsed : { body: taskResult }
    } catch {
      record = { body: taskResult }
    }
  }
  const body = typeof record.body === 'string' ? record.body : ''
  const parsedBody = parseWorkflowResultBody(body)
  const outcome =
    record.outcome === 'succeeded' || record.outcome === 'failed' ? record.outcome : fallbackOutcome
  return {
    outcome,
    subject: typeof record.subject === 'string' ? record.subject : '',
    summary: parsedBody.summary,
    data: parsedBody.data,
    dataError: parsedBody.dataError,
    filesModified: Array.isArray(record.filesModified)
      ? record.filesModified.filter((file): file is string => typeof file === 'string')
      : [],
    reportPath: typeof record.reportPath === 'string' ? record.reportPath : null,
    messageId: typeof record.messageId === 'string' ? record.messageId : null,
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : null
  }
}
