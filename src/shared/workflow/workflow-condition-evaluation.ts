import type { WorkflowCondition } from './workflow-condition-schema'
import { isWorkflowJsonRecord } from './workflow-json-record'

export type WorkflowConditionSubject = {
  outcome: 'succeeded' | 'failed' | null
  approval: 'approved' | 'rejected' | null
  /** The worker's parsed WORKFLOW_RESULT object; empty when it sent none. */
  data: Readonly<Record<string, unknown>>
}

function readPath(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = data
  for (const key of path.split('.')) {
    // Own keys only: a prototype key such as constructor must never resolve.
    if (!isWorkflowJsonRecord(current) || !Object.hasOwn(current, key)) {
      return undefined
    }
    current = current[key]
  }
  return current
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.trim().toLowerCase() === expected.trim().toLowerCase()
  }
  return actual === expected
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase().includes(expected.toLowerCase())
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => looseEquals(item, expected))
  }
  return false
}

function compareNumbers(actual: unknown, expected: unknown, op: 'gt' | 'lt'): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') {
    return false
  }
  return op === 'gt' ? actual > expected : actual < expected
}

/** Pure and total: an unreadable field makes a comparison false, never an exception. */
export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  subject: WorkflowConditionSubject
): boolean {
  switch (condition.kind) {
    case 'always':
      return true
    case 'outcome':
      return subject.outcome === condition.equals
    case 'approval':
      return subject.approval === condition.equals
    case 'all':
      return condition.conditions.every((child) => evaluateWorkflowCondition(child, subject))
    case 'any':
      return condition.conditions.some((child) => evaluateWorkflowCondition(child, subject))
    case 'not':
      return !evaluateWorkflowCondition(condition.condition, subject)
    case 'field': {
      const actual = readPath(subject.data, condition.path)
      switch (condition.op) {
        case 'exists':
          return actual !== undefined && actual !== null
        case 'not-exists':
          return actual === undefined || actual === null
        case 'equals':
          return looseEquals(actual, condition.value)
        case 'not-equals':
          return !looseEquals(actual, condition.value)
        case 'contains':
          return contains(actual, condition.value)
        case 'gt':
        case 'lt':
          return compareNumbers(actual, condition.value, condition.op)
      }
    }
  }
}

export function describeWorkflowCondition(condition: WorkflowCondition | null): string {
  if (!condition) {
    return 'always'
  }
  switch (condition.kind) {
    case 'always':
      return 'always'
    case 'outcome':
      return `outcome is ${condition.equals}`
    case 'approval':
      return condition.equals
    case 'field':
      return condition.op === 'exists' || condition.op === 'not-exists'
        ? `${condition.path} ${condition.op === 'exists' ? 'exists' : 'missing'}`
        : `${condition.path} ${condition.op} ${String(condition.value ?? '')}`
    case 'all':
      return condition.conditions.map(describeWorkflowCondition).join(' and ')
    case 'any':
      return condition.conditions.map(describeWorkflowCondition).join(' or ')
    case 'not':
      return `not (${describeWorkflowCondition(condition.condition)})`
  }
}
