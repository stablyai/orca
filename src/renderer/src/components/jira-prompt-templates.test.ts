import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import {
  renderJiraPromptTemplate,
  getJiraPromptTemplates,
  buildJiraIssuePrompt
} from './jira-prompt-templates'
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  title: 'Fix $other-prompt in login',
  description: 'Keep $jira-issue literal in the example.',
  url: 'https://jira.example/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
describe('Jira prompt templates', () => {
  it('substitutes supported placeholders once and keeps inserted issue content intact', () => {
    expect(
      renderJiraPromptTemplate(
        'Use $jira-issue plus $other-prompt',
        issue,
        '  Include mobile checks.  '
      )
    ).toBe(`Use ${buildJiraIssuePrompt(issue)} plus Include mobile checks.`)
  })
  it('replaces repeated variables and preserves unknown variables and longer names', () => {
    expect(
      renderJiraPromptTemplate('$other-prompt $other-prompt $unknown $jira-issues', issue, 'note')
    ).toBe('note note $unknown $jira-issues')
  })
  it('includes key, title, URL, description and the chosen goal in all built-in prompts', () => {
    for (const template of getJiraPromptTemplates()) {
      const prompt = renderJiraPromptTemplate(template.text, issue, 'Run integration checks.')
      expect(prompt).toContain(issue.key)
      expect(prompt).toContain(issue.title)
      expect(prompt).toContain(issue.url)
      expect(prompt).toContain(issue.description)
      expect(prompt).toContain('Run integration checks.')
    }
  })
})
