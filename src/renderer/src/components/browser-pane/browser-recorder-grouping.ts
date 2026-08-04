// ---------------------------------------------------------------------------
// Browser action recorder — step grouping
//
// Turns the flat step stream into trigger groups: a lead step (interaction
// click/type/keydown, automation action, navigation) opens a group, and the
// network requests and console messages that follow it belong to that group.
// Hover/scroll render on their own line but keep the group open — a click's
// requests usually arrive after the mouse moved away (loading blockers,
// tooltips), so a hover must not sever the click → request causality chain.
// element-selected/annotation/network-summary close the group and stand
// alone. Both the compact markdown log and the tray list render the same
// grouping, so the UI and the copied log agree on what belongs to what.
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
    default:
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
    case 'network-summary':
      return true
    default:
      return false
  }
}

/**
 * Groups steps so requests/console messages hang off their triggering lead.
 * Hover/scroll keep the group open; element-selected/annotation/network-
 * summary close it. Steps without a lead (or before the first lead) form
 * standalone groups.
 */
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
