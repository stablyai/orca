import { describe, expect, it } from 'vitest'
import {
  buildWorkItemOrchestratorName,
  buildWorkItemOrchestratorPrompt,
  type OrchestratorWorkItemInput
} from './orchestrator-work-item-prompt'

const githubIssue: OrchestratorWorkItemInput = {
  provider: 'github',
  title: 'Fix the login redirect',
  url: 'https://github.com/acme/app/issues/42',
  number: 42,
  repoId: 'repo-1'
}

const jiraIssue: OrchestratorWorkItemInput = {
  provider: 'jira',
  title: 'Ship the billing page',
  url: 'https://acme.atlassian.net/browse/RIQAPP-178',
  identifier: 'RIQAPP-178'
}

describe('buildWorkItemOrchestratorName', () => {
  it('prefers the tracker identifier when present', () => {
    expect(buildWorkItemOrchestratorName(jiraIssue)).toBe('RIQAPP-178 Ship the billing page')
  })

  it('falls back to #number for numeric trackers', () => {
    expect(buildWorkItemOrchestratorName(githubIssue)).toBe('#42 Fix the login redirect')
  })

  it('uses the bare title when there is neither identifier nor number', () => {
    expect(
      buildWorkItemOrchestratorName({ ...jiraIssue, identifier: undefined, number: null })
    ).toBe('Ship the billing page')
  })
})

describe('buildWorkItemOrchestratorPrompt', () => {
  it('heads the prompt with the identifier and includes the url', () => {
    const prompt = buildWorkItemOrchestratorPrompt(jiraIssue)
    expect(prompt).toContain('RIQAPP-178: Ship the billing page')
    expect(prompt).toContain('https://acme.atlassian.net/browse/RIQAPP-178')
    // Directs (plan/split/deliver) rather than implying work is done.
    expect(prompt).toMatch(/Plan and deliver/)
  })

  it('heads numeric trackers with #number', () => {
    expect(buildWorkItemOrchestratorPrompt(githubIssue)).toContain('#42: Fix the login redirect')
  })
})
