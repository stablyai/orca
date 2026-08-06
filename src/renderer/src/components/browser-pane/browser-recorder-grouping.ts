// ---------------------------------------------------------------------------
// Browser action recorder — step grouping
//
// Requests/console messages hang off their triggering lead (click/type/keydown,
// automation action, navigation). Hover/scroll stay on their own line but keep
// the group open — a click's requests usually arrive after the mouse moved
// away, so a hover must not sever the click → request causality chain.
// ---------------------------------------------------------------------------

import type { BrowserRecorderStep } from './browser-recorder-types'

/** One step inside a group after the lead. */
export type BrowserRecorderGroupItem =
  | { kind: 'member'; step: BrowserRecorderStep }
  | { kind: 'inline'; step: BrowserRecorderStep }

export type BrowserRecorderStepGroup = {
  /** The step that opened the group; null for a standalone group. */
  lead: BrowserRecorderStep | null
  /** Chronological steps after the lead, in arrival order. */
  items: BrowserRecorderGroupItem[]
}

function isLeadStep(step: BrowserRecorderStep): boolean {
  switch (step.detail.kind) {
    case 'recording-started':
    case 'automation-action':
    case 'navigation':
      return true
    case 'interaction':
      return (
        step.detail.interaction.kind === 'click' ||
        step.detail.interaction.kind === 'type' ||
        step.detail.interaction.kind === 'keydown'
      )
    case 'element-selected':
    case 'annotation-added':
    case 'annotation-removed':
    case 'markup':
    case 'console':
    case 'network-request':
    case 'network-summary':
      return false
  }
}

/** Steps rendered on their own line inside a group, without closing it. */
function isInlineStep(step: BrowserRecorderStep): boolean {
  return (
    step.detail.kind === 'interaction' &&
    (step.detail.interaction.kind === 'hover' || step.detail.interaction.kind === 'scroll')
  )
}

/** Steps that close the current group and stand on their own line. */
function isClosingStep(step: BrowserRecorderStep): boolean {
  switch (step.detail.kind) {
    case 'element-selected':
    case 'annotation-added':
    case 'annotation-removed':
    case 'markup':
    case 'network-summary':
      return true
    case 'recording-started':
    case 'navigation':
    case 'automation-action':
    case 'interaction':
    case 'console':
    case 'network-request':
      return false
  }
}

export function groupRecorderSteps(steps: BrowserRecorderStep[]): BrowserRecorderStepGroup[] {
  const groups: BrowserRecorderStepGroup[] = []
  let open: BrowserRecorderStepGroup | null = null
  for (const step of steps) {
    if (isLeadStep(step)) {
      open = { lead: step, items: [] }
      groups.push(open)
      continue
    }
    if (isClosingStep(step)) {
      open = null
      groups.push({ lead: null, items: [{ kind: 'inline', step }] })
      continue
    }
    if (open) {
      open.items.push(isInlineStep(step) ? { kind: 'inline', step } : { kind: 'member', step })
    } else {
      groups.push({ lead: null, items: [{ kind: 'inline', step }] })
    }
  }
  return groups
}
