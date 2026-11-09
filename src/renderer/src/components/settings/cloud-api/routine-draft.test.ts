import { describe, expect, it } from 'vitest'
import type { Routine } from '../../../../../shared/cloud-api/cloud-api-types'
import {
  emptyRoutineDraft,
  routineDraftCron,
  routineDraftFromRoutine,
  routinePatchFromInput,
  validateRoutineDraft,
  withCurrentProject
} from './routine-draft'

const valid = {
  ...emptyRoutineDraft('America/New_York'),
  name: ' Triage ',
  repoUrl: 'https://github.com/acme/api',
  prompt: 'Label new issues'
}

const routine: Routine = {
  id: 'rt_1',
  name: 'Review',
  projectId: null,
  repo: { url: 'https://github.com/acme/web', ref: 'main' },
  enabled: false,
  trigger: { kind: 'schedule', cron: '30 6 * * 1', timezone: 'Europe/Berlin' },
  agent: 'codex',
  prompt: 'Bump deps',
  postResults: 'pr',
  machineSize: 'standard',
  maxRuntimeMinutes: 45,
  nextRunAt: null,
  lastRun: null,
  createdBy: 'u1',
  createdAt: 1,
  updatedAt: 1
}

describe('routine draft', () => {
  it('builds the contract body for a weekday schedule on a repo URL', () => {
    const result = validateRoutineDraft(valid)
    expect(result).toEqual({
      ok: true,
      input: {
        name: 'Triage',
        repo: { url: 'https://github.com/acme/api' },
        trigger: { kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'America/New_York' },
        agent: 'claude',
        prompt: 'Label new issues',
        postResults: 'comment',
        enabled: true,
        maxRuntimeMinutes: 30
      }
    })
  })

  it('builds GitHub triggers with trimmed, de-duplicated filters and omits empty ones', () => {
    const result = validateRoutineDraft({
      ...valid,
      triggerKind: 'github',
      githubEvents: ['pull_request.labeled', 'issues.opened'],
      labels: 'orca, orca , ,needs-review',
      authors: '@octocat',
      baseBranches: ''
    })
    expect(result.ok && result.input.trigger).toEqual({
      kind: 'github',
      events: ['pull_request.labeled', 'issues.opened'],
      labels: ['orca', 'needs-review'],
      authors: ['octocat']
    })
  })

  it('sends a project id instead of a repo when a project is chosen', () => {
    const result = validateRoutineDraft({
      ...valid,
      source: 'project',
      projectId: 'prj_1',
      triggerKind: 'webhook'
    })
    expect(result.ok && result.input).toMatchObject({
      projectId: 'prj_1',
      trigger: { kind: 'webhook' }
    })
    expect(result.ok && 'repo' in result.input).toBe(false)
  })

  it('reports each invalid field', () => {
    const result = validateRoutineDraft({
      ...valid,
      name: '',
      repoUrl: 'github.com/acme',
      schedulePreset: 'custom',
      customCron: 'every day',
      prompt: '  ',
      maxRuntimeMinutes: '0'
    })
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'required',
        repoUrl: 'invalid',
        customCron: 'invalid',
        prompt: 'required',
        maxRuntimeMinutes: 'invalid'
      }
    })
    expect(validateRoutineDraft({ ...valid, triggerKind: 'github', githubEvents: [] })).toEqual({
      ok: false,
      errors: { githubEvents: 'required' }
    })
    expect(validateRoutineDraft({ ...valid, source: 'project', projectId: '' })).toEqual({
      ok: false,
      errors: { source: 'required' }
    })
  })

  it('round-trips an existing routine into the editor', () => {
    const draft = routineDraftFromRoutine(routine, 'UTC')
    expect(draft).toMatchObject({
      source: 'repo',
      repoUrl: 'https://github.com/acme/web',
      repoRef: 'main',
      schedulePreset: 'weekly',
      dayOfWeek: 1,
      time: '06:30',
      timezone: 'Europe/Berlin',
      enabled: false,
      maxRuntimeMinutes: '45'
    })
    expect(routineDraftCron(draft)).toBe('30 6 * * 1')

    const custom = routineDraftFromRoutine(
      { ...routine, trigger: { kind: 'schedule', cron: '*/15 * * * *', timezone: 'UTC' } },
      'UTC'
    )
    expect(custom.schedulePreset).toBe('custom')
    expect(routineDraftCron(custom)).toBe('*/15 * * * *')

    const github = routineDraftFromRoutine(
      {
        ...routine,
        trigger: { kind: 'github', events: ['issues.labeled'], labels: ['bug', 'p1'] }
      },
      'UTC'
    )
    expect(github).toMatchObject({
      triggerKind: 'github',
      githubEvents: ['issues.labeled'],
      labels: 'bug, p1'
    })
  })
})

describe('routine edits', () => {
  const input = (draft: Parameters<typeof validateRoutineDraft>[0]) => {
    const result = validateRoutineDraft(draft)
    if (!result.ok) {
      throw new Error('invalid draft')
    }
    return result.input
  }

  it('sends nothing when nothing changed, and never re-sends enabled', () => {
    const draft = routineDraftFromRoutine(routine, 'UTC')
    expect(routinePatchFromInput(routine, input({ ...draft, enabled: true }))).toEqual({})
  })

  it('clears the other source and the time limit with explicit nulls', () => {
    const draft = routineDraftFromRoutine(routine, 'UTC')
    expect(
      routinePatchFromInput(
        routine,
        input({ ...draft, source: 'project', projectId: 'prj_9', maxRuntimeMinutes: '' })
      )
    ).toEqual({ projectId: 'prj_9', repo: null, maxRuntimeMinutes: null })
    const projectRoutine = { ...routine, projectId: 'prj_9', repo: null }
    expect(
      routinePatchFromInput(
        projectRoutine,
        input({
          ...routineDraftFromRoutine(projectRoutine, 'UTC'),
          source: 'repo',
          repoUrl: 'https://github.com/a/b'
        })
      )
    ).toEqual({ repo: { url: 'https://github.com/a/b' }, projectId: null })
  })

  it('sends only the changed trigger', () => {
    const draft = routineDraftFromRoutine(routine, 'UTC')
    expect(routinePatchFromInput(routine, input({ ...draft, time: '07:00' }))).toEqual({
      trigger: { kind: 'schedule', cron: '0 7 * * 1', timezone: 'Europe/Berlin' }
    })
  })

  it('keeps an unknown current project selectable', () => {
    expect(withCurrentProject([], 'prj_x', 'Current project')).toEqual([
      { id: 'prj_x', name: 'Current project', repo: null }
    ])
    expect(withCurrentProject([], '', 'Current project')).toEqual([])
  })
})
