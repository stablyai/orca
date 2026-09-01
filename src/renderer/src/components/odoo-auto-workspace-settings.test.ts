import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS,
  ODOO_AUTO_WORKSPACE_MAX_PER_RUN,
  parseOdooAutoWorkspaceSettings
} from './odoo-auto-workspace-settings'

describe('parseOdooAutoWorkspaceSettings', () => {
  it('falls back to the disabled default for missing or malformed payloads', () => {
    expect(parseOdooAutoWorkspaceSettings(null)).toEqual(DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS)
    expect(parseOdooAutoWorkspaceSettings('not json')).toEqual(DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS)
    expect(parseOdooAutoWorkspaceSettings('[]')).toEqual(DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS)
  })

  it('refuses to look armed without a target repo', () => {
    const parsed = parseOdooAutoWorkspaceSettings(JSON.stringify({ enabled: true }))
    expect(parsed.enabled).toBe(false)
    expect(parsed.repoId).toBeNull()
  })

  it('treats a blank repo id as no target repo', () => {
    const parsed = parseOdooAutoWorkspaceSettings(JSON.stringify({ enabled: true, repoId: '   ' }))
    expect(parsed.repoId).toBeNull()
    expect(parsed.enabled).toBe(false)
  })

  it('trims a padded repo id', () => {
    const parsed = parseOdooAutoWorkspaceSettings(
      JSON.stringify({ enabled: true, repoId: '  repo-1  ' })
    )
    expect(parsed.repoId).toBe('repo-1')
    expect(parsed.enabled).toBe(true)
  })

  it('keeps a fully configured payload', () => {
    const parsed = parseOdooAutoWorkspaceSettings(
      JSON.stringify({
        enabled: true,
        repoId: 'repo-1',
        baseBranch: '  main  ',
        maxPerRun: 2,
        criteria: { assignedToMe: true, priorities: ['3'], stageIds: [4], requireDescription: true }
      })
    )
    expect(parsed).toMatchObject({
      enabled: true,
      repoId: 'repo-1',
      baseBranch: 'main',
      maxPerRun: 2
    })
    expect(parsed.criteria).toMatchObject({
      priorities: ['3'],
      stageIds: [4],
      requireDescription: true
    })
  })

  it('clamps the per-run cap to the hard ceiling', () => {
    const parsed = parseOdooAutoWorkspaceSettings(
      JSON.stringify({ enabled: true, repoId: 'r', maxPerRun: 999 })
    )
    expect(parsed.maxPerRun).toBe(ODOO_AUTO_WORKSPACE_MAX_PER_RUN)
  })

  it('drops unknown priorities and non-integer stage ids', () => {
    const parsed = parseOdooAutoWorkspaceSettings(
      JSON.stringify({
        repoId: 'r',
        criteria: { priorities: ['9', '3', '3'], stageIds: [1, 'x', 1.5] }
      })
    )
    expect(parsed.criteria.priorities).toEqual(['3'])
    expect(parsed.criteria.stageIds).toEqual([1])
  })

  it('treats a negative deadline window as no window', () => {
    const parsed = parseOdooAutoWorkspaceSettings(
      JSON.stringify({ repoId: 'r', criteria: { deadlineWithinDays: -5 } })
    )
    expect(parsed.criteria.deadlineWithinDays).toBeNull()
  })
})
