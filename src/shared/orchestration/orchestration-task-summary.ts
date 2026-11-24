const TASK_SPEC_BRIEF_LENGTH = 160

export function abbreviateOrchestrationTasks<T extends { spec: string }>(
  tasks: readonly T[]
): (T & { spec_truncated: boolean })[] {
  return tasks.map((task) => ({
    ...task,
    spec: abbreviateOrchestrationText(task.spec),
    // Whitespace cleanup alone must not trigger agents to refetch an already complete brief.
    spec_truncated: task.spec.replace(/\s+/g, ' ').trim().length > TASK_SPEC_BRIEF_LENGTH
  }))
}

/** One line of at most 160 characters, ending in … when cut. */
export function abbreviateOrchestrationText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TASK_SPEC_BRIEF_LENGTH ? `${truncateAtCodePoint(flat).trimEnd()}…` : flat
}

function truncateAtCodePoint(spec: string): string {
  const sliced = spec.slice(0, TASK_SPEC_BRIEF_LENGTH - 1)
  // Drop a split high surrogate rather than send malformed UTF-16 to strict JSON consumers.
  const lastUnit = sliced.charCodeAt(sliced.length - 1)
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? sliced.slice(0, -1) : sliced
}
