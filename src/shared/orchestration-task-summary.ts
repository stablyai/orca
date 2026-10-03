const TASK_BRIEF_FIELD_LENGTH = 160

type BriefTaskFields = {
  spec: string
  result?: string | null
  spec_truncated?: boolean
  result_truncated?: boolean
}

export function abbreviateOrchestrationTasks<T extends BriefTaskFields>(
  tasks: readonly T[]
): (T & { spec_truncated: boolean; result_truncated: boolean })[] {
  return tasks.map((task) => {
    // Why: a runtime that already abbreviated a field marks it, and its capped
    // text fits the cap, so re-abbreviating would flip the flag back to false.
    const spec =
      task.spec_truncated === undefined
        ? abbreviateText(task.spec)
        : { text: task.spec, truncated: task.spec_truncated }
    const result =
      task.result_truncated === undefined && typeof task.result === 'string'
        ? abbreviateText(task.result)
        : undefined
    return {
      ...task,
      spec: spec.text,
      // Why: whitespace normalization alone is not truncation; flagging it
      // would make agents re-fetch full specs that --brief already shows.
      spec_truncated: spec.truncated,
      // Why: completed results are often full worker reports already delivered
      // via worker_done; a brief listing should not re-ship them (#20701).
      ...(result ? { result: result.text } : {}),
      result_truncated: result?.truncated ?? task.result_truncated ?? false
    }
  })
}

function abbreviateText(value: string): { text: string; truncated: boolean } {
  const text = value.replace(/\s+/g, ' ').trim()
  const truncated = text.length > TASK_BRIEF_FIELD_LENGTH
  return { text: truncated ? `${truncateAtCodePoint(text).trimEnd()}…` : text, truncated }
}

function truncateAtCodePoint(text: string): string {
  const sliced = text.slice(0, TASK_BRIEF_FIELD_LENGTH - 1)
  // Why: a cut through a surrogate pair leaves a lone high surrogate that
  // strict JSON consumers reject; drop it rather than emit malformed UTF-16.
  const lastUnit = sliced.charCodeAt(sliced.length - 1)
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? sliced.slice(0, -1) : sliced
}
