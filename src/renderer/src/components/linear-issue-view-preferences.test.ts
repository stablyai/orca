import { describe, expect, it } from 'vitest'
import { emptyLinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'
import type { LinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'
import type { TaskResumeState } from '../../../shared/types'
import {
  DEFAULT_LINEAR_DISPLAY_PROPERTIES,
  linearIssueViewPreferencesResumeUpdate,
  resolveLinearIssueViewPreferences,
  shouldResetLinearFilterForWorkspaceChange,
  type LinearIssueViewPreferences
} from './linear-issue-view-preferences'

function filter(overrides: Partial<LinearIssueAttributeFilter> = {}): LinearIssueAttributeFilter {
  return { ...emptyLinearIssueAttributeFilter(), ...overrides }
}

function preferences(
  overrides: Partial<LinearIssueViewPreferences> = {}
): LinearIssueViewPreferences {
  return {
    viewMode: 'list',
    groupBy: 'none',
    orderBy: 'priority',
    displayProperties: new Set(DEFAULT_LINEAR_DISPLAY_PROPERTIES),
    teamPropertyTouched: false,
    attributeFilter: emptyLinearIssueAttributeFilter(),
    ...overrides
  }
}

describe('resolveLinearIssueViewPreferences', () => {
  it('falls back to list/none/priority and every display property without saved state', () => {
    const resolved = resolveLinearIssueViewPreferences(undefined)

    expect(resolved.viewMode).toBe('list')
    expect(resolved.groupBy).toBe('none')
    expect(resolved.orderBy).toBe('priority')
    expect(Array.from(resolved.displayProperties)).toEqual(DEFAULT_LINEAR_DISPLAY_PROPERTIES)
    expect(resolved.teamPropertyTouched).toBe(false)
    expect(resolved.attributeFilter).toEqual(emptyLinearIssueAttributeFilter())
  })

  it('restores saved view options and the saved attribute filter', () => {
    const resume: TaskResumeState = {
      linearViewMode: 'board',
      linearGroupBy: 'assignee',
      linearOrderBy: 'updated',
      linearDisplayProperties: ['state', 'labels'],
      linearTeamPropertyTouched: true,
      linearIssueFilter: filter({ priorities: [1, 2] })
    }

    const resolved = resolveLinearIssueViewPreferences(resume)

    expect(resolved.viewMode).toBe('board')
    expect(resolved.groupBy).toBe('assignee')
    expect(resolved.orderBy).toBe('updated')
    expect(Array.from(resolved.displayProperties)).toEqual(['state', 'labels'])
    expect(resolved.teamPropertyTouched).toBe(true)
    expect(resolved.attributeFilter).toEqual(filter({ priorities: [1, 2] }))
  })

  it('treats an empty saved display-property list as "hide everything", not as missing', () => {
    const resolved = resolveLinearIssueViewPreferences({ linearDisplayProperties: [] })

    expect(Array.from(resolved.displayProperties)).toEqual([])
  })
})

describe('linearIssueViewPreferencesResumeUpdate', () => {
  it('omits an empty filter and its workspace tag so the payload stays "unfiltered"', () => {
    const update = linearIssueViewPreferencesResumeUpdate(preferences(), 'workspace-1')

    expect(update.linearIssueFilter).toBeUndefined()
    expect(update.linearIssueFilterWorkspaceId).toBeUndefined()
  })

  it('canonicalizes a non-empty filter and tags the workspace it was captured under', () => {
    const update = linearIssueViewPreferencesResumeUpdate(
      preferences({ attributeFilter: filter({ labelIds: ['b', 'a', 'a'] }) }),
      'workspace-1'
    )

    expect(update.linearIssueFilter).toEqual(filter({ labelIds: ['a', 'b'] }))
    expect(update.linearIssueFilterWorkspaceId).toBe('workspace-1')
  })

  it('emits display properties in catalog order regardless of toggle order', () => {
    const update = linearIssueViewPreferencesResumeUpdate(
      preferences({ displayProperties: new Set(['updated', 'state']) }),
      'workspace-1'
    )

    expect(update.linearDisplayProperties).toEqual(['state', 'updated'])
  })

  it('drops the workspace tag when no workspace is resolved', () => {
    const update = linearIssueViewPreferencesResumeUpdate(
      preferences({ attributeFilter: filter({ priorities: [0] }) }),
      null
    )

    expect(update.linearIssueFilter).toEqual(filter({ priorities: [0] }))
    expect(update.linearIssueFilterWorkspaceId).toBeUndefined()
  })
})

describe('shouldResetLinearFilterForWorkspaceChange', () => {
  it('resets when the workspace actually changes', () => {
    expect(shouldResetLinearFilterForWorkspaceChange('workspace-1', 'workspace-2')).toBe(true)
  })

  it('keeps the filter when the workspace is unchanged', () => {
    expect(shouldResetLinearFilterForWorkspaceChange('workspace-1', 'workspace-1')).toBe(false)
  })

  it('keeps the restored filter when Linear status first resolves', () => {
    expect(shouldResetLinearFilterForWorkspaceChange(undefined, 'workspace-1')).toBe(false)
  })

  it('keeps the filter while Linear status is unresolved or disconnected', () => {
    expect(shouldResetLinearFilterForWorkspaceChange('workspace-1', null)).toBe(false)
  })
})
