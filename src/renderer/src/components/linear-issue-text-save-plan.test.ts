import { describe, expect, it } from 'vitest'
import { getLinearIssueTextSavePlan } from './linear-issue-text-save-plan'

describe('getLinearIssueTextSavePlan', () => {
  it('skips description saves when only stored trailing whitespace differs', () => {
    const plan = getLinearIssueTextSavePlan({
      descriptionDraft: 'Details\n',
      field: 'description',
      issue: { title: 'Issue title', description: 'Details\n' },
      titleDraft: 'Issue title'
    })

    expect(plan).toEqual({ kind: 'unchanged' })
  })

  it('still saves meaningful description edits with trailing whitespace trimmed', () => {
    const plan = getLinearIssueTextSavePlan({
      descriptionDraft: 'Updated details\n',
      field: 'description',
      issue: { title: 'Issue title', description: 'Details\n' },
      titleDraft: 'Issue title'
    })

    expect(plan).toEqual({ kind: 'changed', patch: { description: 'Updated details' } })
  })

  it('preserves the required-title guard', () => {
    const plan = getLinearIssueTextSavePlan({
      descriptionDraft: 'Details',
      field: 'title',
      issue: { title: 'Issue title', description: 'Details' },
      titleDraft: '   '
    })

    expect(plan).toEqual({ kind: 'empty-title' })
  })
})
