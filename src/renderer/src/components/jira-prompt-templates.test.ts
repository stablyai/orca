import { describe, expect, it } from 'vitest'
import { adfToMarkdownText } from '../../../main/jira/adf-markdown'
import { formatJiraIssue } from '../../../cli/jira/jira-format'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { renderJiraPromptTemplate, buildJiraIssuePrompt } from './jira-prompt-templates'
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
})

it('keeps a CJK issue description readable in terminal output and copied prompts', () => {
  const description = adfToMarkdownText({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '「重要」', marks: [{ type: 'strong' }] },
          { type: 'text', text: 'です ' },
          { type: 'text', text: '「注意」', marks: [{ type: 'em' }] },
          { type: 'text', text: 'です' }
        ]
      }
    ]
  })
  const cjkIssue = { ...issue, description }
  expect(formatJiraIssue(cjkIssue)).toContain('**「重要」**です *「注意」*です')
  expect(renderJiraPromptTemplate('$jira-issue', cjkIssue, '')).toContain(
    '**「重要」**です *「注意」*です'
  )
})
