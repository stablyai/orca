const TASK_SPEC_BRIEF_LENGTH = 160

export function abbreviateOrchestrationTasks<T extends { spec: string }>(
  tasks: readonly T[]
): (T & { spec_truncated: boolean })[] {
  return tasks.map((task) => {
    const spec = task.spec.replace(/\s+/g, ' ').trim()
    const truncated = spec.length > TASK_SPEC_BRIEF_LENGTH
    return {
      ...task,
      spec: truncated ? `${truncateAtCodePoint(spec).trimEnd()}…` : spec,
      // Why: whitespace normalization alone is not truncation; flagging it
      // would make agents re-fetch full specs that --brief already shows.
      spec_truncated: truncated
    }
  })
}

function truncateAtCodePoint(spec: string): string {
  const sliced = spec.slice(0, TASK_SPEC_BRIEF_LENGTH - 1)
  // Why: a cut through a surrogate pair leaves a lone high surrogate that
  // strict JSON consumers reject; drop it rather than emit malformed UTF-16.
  const lastUnit = sliced.charCodeAt(sliced.length - 1)
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? sliced.slice(0, -1) : sliced
}
