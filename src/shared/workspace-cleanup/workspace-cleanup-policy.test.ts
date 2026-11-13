import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspaceCleanupRules,
  resolveWorkspaceCleanupPolicy
} from './workspace-cleanup-policy'

const CUSTOM_RULES = {
  merged: { enabled: true },
  unchanged: { enabled: true, afterDays: 3 },
  inactive: { enabled: true, afterDays: 14, action: 'delete' },
  automationRuns: { enabled: true },
  orchestrationWorkers: { enabled: false },
  keepWhen: 'uncommitted'
} as const

describe('normalizeWorkspaceCleanupRules', () => {
  it('repairs invalid fields and fills missing ones with off-by-default rules', () => {
    expect(
      normalizeWorkspaceCleanupRules({
        merged: { enabled: 'yes' },
        unchanged: { enabled: true, afterDays: 0 },
        inactive: { afterDays: 9999.4, action: 'shred' },
        orchestrationWorkers: null,
        keepWhen: 'everything'
      })
    ).toEqual({
      merged: { enabled: false },
      unchanged: { enabled: true, afterDays: 1 },
      inactive: { enabled: false, afterDays: 3650, action: 'archive' },
      automationRuns: { enabled: false },
      orchestrationWorkers: { enabled: false },
      keepWhen: 'any-local-files'
    })
  })
})

describe('resolveWorkspaceCleanupPolicy', () => {
  const settings = { workspaceCleanupPolicy: CUSTOM_RULES }

  it('uses the global rules when the project has no override', () => {
    expect(resolveWorkspaceCleanupPolicy(settings, {})).toEqual({
      source: 'global',
      rules: CUSTOM_RULES,
      inactiveActionSupported: true
    })
  })

  it('turns every rule off for a project set to off but keeps the global keep-when', () => {
    expect(
      resolveWorkspaceCleanupPolicy(settings, { workspaceCleanupPolicy: { mode: 'off' } })
    ).toEqual({
      source: 'project-off',
      rules: {
        merged: { enabled: false },
        unchanged: { enabled: false, afterDays: 3 },
        inactive: { enabled: false, afterDays: 14, action: 'delete' },
        automationRuns: { enabled: false },
        orchestrationWorkers: { enabled: false },
        keepWhen: 'uncommitted'
      },
      inactiveActionSupported: true
    })
  })

  it("uses a project's custom rules and flags archive as not yet supported", () => {
    expect(
      resolveWorkspaceCleanupPolicy(settings, {
        workspaceCleanupPolicy: {
          mode: 'custom',
          rules: { ...CUSTOM_RULES, inactive: { enabled: true, afterDays: 60, action: 'archive' } }
        }
      })
    ).toEqual({
      source: 'project-custom',
      rules: { ...CUSTOM_RULES, inactive: { enabled: true, afterDays: 60, action: 'archive' } },
      inactiveActionSupported: false
    })
  })

  it('treats settings without cleanup rules as every rule off', () => {
    expect(resolveWorkspaceCleanupPolicy({}, undefined)).toEqual({
      source: 'global',
      rules: {
        merged: { enabled: false },
        unchanged: { enabled: false, afterDays: 1 },
        inactive: { enabled: false, afterDays: 30, action: 'archive' },
        automationRuns: { enabled: false },
        orchestrationWorkers: { enabled: false },
        keepWhen: 'any-local-files'
      },
      inactiveActionSupported: false
    })
  })
})
