import { describe, expect, it } from 'vitest'
import { getDirectWorkItemDraftContent } from './launch-work-item-direct-draft'

describe('getDirectWorkItemDraftContent', () => {
  it('applies a custom Linear template', async () => {
    const draft = await getDirectWorkItemDraftContent(
      {
        provider: 'linear',
        url: 'https://linear.app/acme/issue/ENG-9/x',
        linearIdentifier: 'ENG-9'
      } as never,
      null,
      'Do {{identifier}}'
    )
    expect(draft).toBe('Do ENG-9\n')
  })

  it('falls back to the built-in draft without a template', async () => {
    const draft = await getDirectWorkItemDraftContent(
      {
        provider: 'linear',
        url: 'https://linear.app/acme/issue/ENG-9/x',
        linearIdentifier: 'ENG-9'
      } as never,
      null
    )
    expect(draft).toBe('Linked Linear issue: ENG-9\nhttps://linear.app/acme/issue/ENG-9/x\n')
  })
})
