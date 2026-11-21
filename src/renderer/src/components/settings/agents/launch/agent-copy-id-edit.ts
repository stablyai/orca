import { agentCopyBase } from '../../../../../../shared/agent-launch/catalog/agent-copies'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

/** The fixed start of a copy's id: its agent and a dot, such as `claude.`. */
export function agentCopyIdPrefix(agent: TuiAgent): string {
  return `${agent}.`
}

/** Whether `suffix` is a valid editable part of a copy id: lowercase letters, digits and dashes. */
export function isAgentCopyIdSuffix(agent: TuiAgent, suffix: string): boolean {
  return agentCopyBase(`${agentCopyIdPrefix(agent)}${suffix}`) === agent
}

export type AgentCopyIdEdit = {
  /** The editable part after the edit. */
  suffix: string
  /** Where the caret goes in the whole id once the field shows `prefix + suffix`. */
  caret: number
}

function commonStart(a: string, b: string, limit: number): number {
  let n = 0
  while (n < limit && a[n] === b[n]) {
    n++
  }
  return n
}

function commonEnd(a: string, b: string, limit: number): number {
  let n = 0
  while (n < limit && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n++
  }
  return n
}

/**
 * Applies one edit of the id field to its suffix. The field holds the whole id, so a selection
 * covers the prefix and the suffix in one go and copies as one string, but the prefix never
 * changes: the part of an edit that reaches into it applies from the suffix's start instead, and
 * pasting a whole id (`claude.xyz`) keeps only its suffix. Whitespace never enters an id.
 *
 * `before` is the value the field showed, `after` is the value the browser produced, and
 * `caret` is the caret after the edit, which places the change when the text around it repeats.
 * `editStart` is where the selection started just before the edit: an edit never starts after
 * it, so typing `c` over a selection that starts with `c` still inserts the `c`.
 */
export function applyAgentCopyIdEdit(
  prefix: string,
  before: string,
  after: string,
  caret: number | null,
  editStart: number | null = null
): AgentCopyIdEdit {
  const fixed = before.startsWith(prefix) ? before : prefix
  const oldSuffix = fixed.slice(prefix.length)
  // The inserted text ends at the caret, so only text after it can be the unchanged tail.
  const tailLimit = Math.min(fixed.length, caret === null ? after.length : after.length - caret)
  const tail = commonEnd(fixed, after, Math.max(0, tailLimit))
  const head = Math.min(
    commonStart(fixed, after, Math.min(fixed.length - tail, after.length - tail)),
    editStart ?? Number.POSITIVE_INFINITY
  )
  let inserted = after.slice(head, after.length - tail).replace(/\s+/g, '')
  const removeStart = Math.max(head, prefix.length) - prefix.length
  const removeEnd = Math.max(fixed.length - tail, prefix.length) - prefix.length
  if (removeStart === 0 && inserted.startsWith(prefix)) {
    inserted = inserted.slice(prefix.length)
  }
  return {
    suffix: oldSuffix.slice(0, removeStart) + inserted + oldSuffix.slice(removeEnd),
    caret: prefix.length + removeStart + inserted.length
  }
}
