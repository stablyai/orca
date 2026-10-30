import { describe, expect, it } from 'vitest'
import { getIssueTextSavePlan } from './issue-text-save-plan'

describe('getIssueTextSavePlan', () => {
  it('skips description saves when only stored trailing whitespace differs', () => {
    const plan = getIssueTextSavePlan({
      descriptionDraft: 'Details\n',
      field: 'description',
      issue: { title: 'Issue title', description: 'Details\n' },
      titleDraft: 'Issue title'
    })

    expect(plan).toEqual({ kind: 'unchanged' })
  })

  it('still saves meaningful description edits with trailing whitespace trimmed', () => {
    const plan = getIssueTextSavePlan({
      descriptionDraft: 'Updated details\n',
      field: 'description',
      issue: { title: 'Issue title', description: 'Details\n' },
      titleDraft: 'Issue title'
    })

    expect(plan).toEqual({ kind: 'changed', patch: { description: 'Updated details' } })
  })
})
