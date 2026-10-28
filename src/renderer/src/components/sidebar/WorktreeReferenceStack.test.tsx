// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeReferenceStack } from './WorktreeReferenceStack'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { referenceAttachment, referenceReview } from './workspace-reference-fixtures.test-support'

afterEach(cleanup)
describe('fixed workspace reference stacks', () => {
  it('prioritizes the review needing attention over a legacy primary and preserves sibling states', () => {
    const items = [referenceAttachment(1), referenceAttachment(2), referenceAttachment(3)]
    const details = Object.fromEntries(
      items.map((item, index) => [
        getWorkspaceAttachmentKey(item),
        {
          title: '',
          url: item.url ?? '',
          review: referenceReview(item.number, {
            state: index === 0 ? 'merged' : index === 1 ? 'draft' : 'open',
            status: index === 2 ? 'failure' : 'success'
          })
        }
      ])
    )
    const { container } = render(<WorktreeReferenceStack items={items} details={details} />)
    expect(
      container.querySelector('[data-reference-front] svg')?.classList.contains('text-rose-500/85')
    ).toBe(true)
    expect(container.querySelectorAll('.workspace-reference-stack-ghost')).toHaveLength(2)
    expect(container.querySelector('[data-reference-count]')?.textContent).toBe('3')
    expect(container.textContent).toContain('PR #2 · draft')
  })
})
