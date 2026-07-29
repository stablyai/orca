import { describe, expect, it } from 'vitest'
import { getDirectWorkItemDraftContent } from './launch-work-item-direct-draft'
import type { LaunchableWorkItem } from './launch-work-item-direct-types'

const LINEAR_WORK_ITEM: LaunchableWorkItem = {
  provider: 'linear',
  title: 'Fix launch context handoff',
  url: 'https://linear.app/acme/issue/ENG-9/x',
  type: 'issue',
  number: 0,
  linearIdentifier: 'ENG-9'
}

describe('getDirectWorkItemDraftContent', () => {
  it('applies a custom Linear template', async () => {
    const draft = await getDirectWorkItemDraftContent(LINEAR_WORK_ITEM, null, 'Do {{identifier}}')
    expect(draft).toBe('Do ENG-9\n')
  })

  it('falls back to the built-in draft without a template', async () => {
    const draft = await getDirectWorkItemDraftContent(LINEAR_WORK_ITEM, null)
    expect(draft).toBe('Linked Linear issue: ENG-9\nhttps://linear.app/acme/issue/ENG-9/x\n')
  })
})
