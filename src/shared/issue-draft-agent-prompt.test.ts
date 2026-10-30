import { describe, expect, it } from 'vitest'
import {
  buildIssueDraftAgentPrompt,
  ISSUE_DRAFT_AGENT_PROMPT_ITEM_LIMIT,
  type IssueDraftAgentPromptItem
} from './issue-draft-agent-prompt'

function item(
  number: number,
  overrides: Partial<IssueDraftAgentPromptItem> = {}
): IssueDraftAgentPromptItem {
  return {
    kind: 'issue',
    number,
    title: `Item ${number}`,
    state: 'open',
    url: `https://github.com/acme/app/issues/${number}`,
    labels: [],
    ...overrides
  }
}

describe('buildIssueDraftAgentPrompt', () => {
  it('files only after explicit confirmation and lists the shown items', () => {
    const prompt = buildIssueDraftAgentPrompt({
      repositoryLabel: 'acme/app',
      query: 'is:open label:bug',
      existingItems: [item(1, { labels: ['bug'] }), item(2, { kind: 'pr', state: 'draft' })]
    })

    expect(prompt).toContain('issue-drafting assistant for acme/app')
    expect(prompt).toContain('Check for duplicates first')
    expect(prompt).toContain('only after I explicitly tell you to file that draft')
    expect(prompt).toContain('Items currently shown in the task list (filter: is:open label:bug):')
    expect(prompt).toContain(
      '- Issue #1 (open) Item 1 [bug] — https://github.com/acme/app/issues/1'
    )
    expect(prompt).toContain('- PR #2 (draft) Item 2')
    expect(prompt.endsWith('ask what I want to file.')).toBe(true)
  })

  it('caps the listed rows and says how many were left out', () => {
    const existingItems = Array.from({ length: ISSUE_DRAFT_AGENT_PROMPT_ITEM_LIMIT + 3 }, (_, i) =>
      item(i + 1)
    )
    const prompt = buildIssueDraftAgentPrompt({
      repositoryLabel: 'acme/app',
      query: null,
      existingItems
    })

    expect(prompt).toContain(`#${ISSUE_DRAFT_AGENT_PROMPT_ITEM_LIMIT} `)
    expect(prompt).not.toContain(`#${ISSUE_DRAFT_AGENT_PROMPT_ITEM_LIMIT + 1} `)
    expect(prompt).toContain('…and 3 more not listed here')
  })
})
