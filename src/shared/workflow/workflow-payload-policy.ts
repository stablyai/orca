import type { WorkflowPayloadPolicy } from './workflow-communication-schema'
import type { WorkflowWorkerReport } from './workflow-worker-result'
import { isWorkflowJsonRecord } from './workflow-json-record'

export type WorkflowBuiltPayload = {
  format: 'text' | 'json'
  text: string
  bytes: number
  estimatedTokens: number
  /** Limits of what Orca can actually forward, shown next to the payload. */
  notes: string[]
}

const encoder = new TextEncoder()

export function workflowPayloadBytes(text: string): number {
  return encoder.encode(text).length
}

/** A rough 4-bytes-per-token estimate; always labeled estimated in the UI. */
export function estimateWorkflowTokens(bytes: number): number {
  return Math.ceil(bytes / 4)
}

function built(format: 'text' | 'json', text: string, notes: string[] = []): WorkflowBuiltPayload {
  const bytes = workflowPayloadBytes(text)
  return { format, text, bytes, estimatedTokens: estimateWorkflowTokens(bytes), notes }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function recipientTaskSpec(report: WorkflowWorkerReport, recipientNodeId: string): string | null {
  const tasks = report.data.tasks
  if (isWorkflowJsonRecord(tasks)) {
    const spec = tasks[recipientNodeId]
    if (typeof spec === 'string') {
      return spec
    }
    if (spec && typeof spec === 'object') {
      return JSON.stringify(spec, null, 2)
    }
  }
  return null
}

/** Build only what the edge permits; the sender's conversation is never an input. */
export function buildWorkflowEdgePayload(args: {
  policy: WorkflowPayloadPolicy
  report: WorkflowWorkerReport
  recipientNodeId: string
  senderWorktreeId: string | null
}): WorkflowBuiltPayload {
  const { policy, report } = args
  switch (policy.kind) {
    case 'task-spec': {
      const spec = recipientTaskSpec(report, args.recipientNodeId)
      return spec
        ? built('text', spec)
        : built('text', report.summary, [
            `The sender returned no tasks.${args.recipientNodeId} entry, so its summary is sent as the task.`
          ])
    }
    case 'structured-json':
      return built(
        'json',
        JSON.stringify(report.data, null, 2),
        report.dataError ? [report.dataError] : []
      )
    case 'summary':
      return built('text', report.summary)
    case 'selected-fields': {
      const picked: Record<string, unknown> = {}
      for (const field of policy.fields) {
        if (Object.hasOwn(report.data, field)) {
          picked[field] = report.data[field]
        }
      }
      const missing = policy.fields.filter((field) => !(field in picked))
      return built(
        'json',
        JSON.stringify(picked, null, 2),
        missing.length > 0 ? [`Missing fields: ${missing.join(', ')}`] : []
      )
    }
    case 'git-diff-ref':
      return built(
        'json',
        JSON.stringify(
          { worktreeId: args.senderWorktreeId, filesModified: report.filesModified },
          null,
          2
        ),
        ['A reference only: the recipient reads the diff from that worktree itself.']
      )
    case 'artifact-refs':
      return built(
        'json',
        JSON.stringify(
          {
            reportPath: report.reportPath,
            filesModified: report.filesModified,
            artifacts: stringList(report.data.artifacts)
          },
          null,
          2
        )
      )
    case 'test-summary': {
      const tests = report.data.tests ?? report.data.testResults
      return tests !== undefined
        ? built('json', JSON.stringify({ tests }, null, 2))
        : built('text', report.summary, [
            'The sender reported no tests field; its summary is sent.'
          ])
    }
    case 'selected-context':
      return built('text', policy.context)
    case 'full-transcript':
      return built(
        'text',
        [report.subject, report.summary, JSON.stringify(report.data, null, 2)].join('\n\n'),
        ['Orca holds the worker report, not the provider transcript; the full report is sent.']
      )
  }
}

/** Cut to a UTF-8 byte budget without splitting a character, and say so in the text. */
export function truncateWorkflowPayload(text: string, maxBytes: number): string {
  const suffix = '\n[truncated by workflow policy]'
  const budget = Math.max(0, maxBytes - workflowPayloadBytes(suffix))
  let out = ''
  let used = 0
  for (const char of text) {
    const size = workflowPayloadBytes(char)
    if (used + size > budget) {
      break
    }
    out += char
    used += size
  }
  return out + suffix
}
