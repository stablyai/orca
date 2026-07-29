// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  isAuditedWorkflowAvailable,
  normalizeAuditedWorkflowActiveView
} from './audited-workflow-availability'
import type { TopLevelView } from '../../../../shared/types'

type WebFlagWindow = { __ORCA_WEB_CLIENT__?: boolean }

// Every TopLevelView member except 'auditedWorkflow' — deliberately hardcoded
// so this test fails to compile (not silently passes) if the union gains a
// member this list doesn't account for.
const NON_WORKFLOW_VIEWS: TopLevelView[] = [
  'terminal',
  'settings',
  'tasks',
  'activity',
  'automations',
  'space',
  'skills',
  'mobile'
]

function setWebClientFlag(value: boolean | undefined): void {
  ;(window as unknown as WebFlagWindow).__ORCA_WEB_CLIENT__ = value
}

describe('isAuditedWorkflowAvailable', () => {
  afterEach(() => {
    setWebClientFlag(undefined)
  })

  it('is available in the local Electron renderer (no web-client marker)', () => {
    setWebClientFlag(undefined)
    expect(isAuditedWorkflowAvailable()).toBe(true)
  })

  it('is NOT available when the paired web client marker is set', () => {
    setWebClientFlag(true)
    expect(isAuditedWorkflowAvailable()).toBe(false)
  })

  it('is available again once the web-client marker is explicitly false', () => {
    setWebClientFlag(false)
    expect(isAuditedWorkflowAvailable()).toBe(true)
  })
})

describe('normalizeAuditedWorkflowActiveView', () => {
  afterEach(() => {
    setWebClientFlag(undefined)
  })

  it('normalizes auditedWorkflow to terminal in the paired web client', () => {
    setWebClientFlag(true)
    expect(normalizeAuditedWorkflowActiveView('auditedWorkflow')).toBe('terminal')
  })

  it('preserves auditedWorkflow in the local Electron renderer', () => {
    setWebClientFlag(undefined)
    expect(normalizeAuditedWorkflowActiveView('auditedWorkflow')).toBe('auditedWorkflow')
  })

  it('leaves every other view unchanged in the paired web client', () => {
    setWebClientFlag(true)
    for (const view of NON_WORKFLOW_VIEWS) {
      expect(normalizeAuditedWorkflowActiveView(view)).toBe(view)
    }
  })

  it('leaves every other view unchanged in the local Electron renderer', () => {
    setWebClientFlag(undefined)
    for (const view of NON_WORKFLOW_VIEWS) {
      expect(normalizeAuditedWorkflowActiveView(view)).toBe(view)
    }
  })
})
