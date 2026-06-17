import { describe, expect, it } from 'vitest'
import type { UserAutomationTemplate } from '../../../../shared/automations-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import {
  applyUserTemplateToDraft,
  draftToUserTemplateInput
} from './automation-user-template-draft'

const BASE_DRAFT: AutomationDraft = {
  name: 'My run',
  prompt: 'do work',
  agentId: 'claude',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: 'ws-1',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: 'pnpm test',
  precheckTimeoutSeconds: '60',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  scheduleWarning: null,
  webhookEnabled: true,
  webhookSecretMode: 'token',
  webhookSecret: 'shh',
  agentModel: 'opus',
  agentLaunchArgs: '--verbose',
  agentEnv: [{ id: 'env-1', key: 'A', value: '1' }]
}

describe('draftToUserTemplateInput', () => {
  it('captures soft fields and the agent config but not the run target', () => {
    const input = draftToUserTemplateInput(BASE_DRAFT, '  My template ', ' desc ')
    expect(input).toEqual({
      label: '  My template ',
      description: ' desc ',
      name: 'My run',
      prompt: 'do work',
      agentId: 'claude',
      agentConfig: { launchArgs: '--verbose', model: 'opus', env: { A: '1' } },
      preset: 'daily',
      time: '09:00',
      dayOfWeek: '1',
      customSchedule: '',
      missedRunGraceMinutes: '720'
    })
    expect(input).not.toHaveProperty('projectId')
    expect(input).not.toHaveProperty('workspaceId')
    expect(input).not.toHaveProperty('webhookEnabled')
    expect(input).not.toHaveProperty('precheckCommand')
  })
})

describe('applyUserTemplateToDraft', () => {
  it('merges template soft fields while preserving the run target and precheck', () => {
    const template: UserAutomationTemplate = {
      id: 't1',
      label: 'Nightly',
      description: '',
      name: 'Nightly run',
      prompt: 'review',
      agentId: 'codex',
      agentConfig: { model: 'gpt-5' },
      preset: 'weekly',
      time: '02:00',
      dayOfWeek: '4',
      customSchedule: null,
      missedRunGraceMinutes: '1440',
      createdAt: 1,
      updatedAt: 2
    }
    const next = applyUserTemplateToDraft(BASE_DRAFT, template)
    expect(next.name).toBe('Nightly run')
    expect(next.agentId).toBe('codex')
    expect(next.agentModel).toBe('gpt-5')
    expect(next.agentLaunchArgs).toBe('')
    expect(next.preset).toBe('weekly')
    expect(next.dayOfWeek).toBe('4')
    // Run target and per-automation fields stay put.
    expect(next.projectId).toBe('repo-1')
    expect(next.workspaceId).toBe('ws-1')
    expect(next.precheckCommand).toBe('pnpm test')
    expect(next.webhookSecret).toBe('shh')
  })
})
