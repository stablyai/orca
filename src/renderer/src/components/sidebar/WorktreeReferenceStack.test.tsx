// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeReferenceStack } from './WorktreeReferenceStack'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { referenceAttachment, referenceReview } from './workspace-reference-fixtures.test-support'
import { summarizeProviderChecks } from '../../../../shared/source-control/checks/provider-check-summary'

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

  it.each([
    ['failure', 'text-rose-500/85'],
    ['pending', 'text-amber-500/85'],
    ['success', 'text-muted-foreground/60']
  ] as const)(
    'orders cancellation between pending and passing with a %s sibling',
    (status, tone) => {
      const items = [referenceAttachment(1), referenceAttachment(2)]
      const cancelledIndex = status === 'success' ? 1 : 0
      const cancellation = {
        status: 'failure' as const,
        checksSummary: summarizeProviderChecks([{ status: 'completed', conclusion: 'cancelled' }])
      }
      const details = Object.fromEntries(
        items.map((item, index) => [
          getWorkspaceAttachmentKey(item),
          {
            title: '',
            url: item.url ?? '',
            review: referenceReview(
              item.number,
              index === cancelledIndex ? cancellation : { status }
            )
          }
        ])
      )
      const { container } = render(<WorktreeReferenceStack items={items} details={details} />)
      expect(container.querySelector('[data-reference-front] svg')?.classList.contains(tone)).toBe(
        true
      )
      expect(container.textContent).toContain(`PR #${cancelledIndex + 1} · open · Cancelled`)
      if (status !== 'success') {
        expect(container.textContent).toContain(
          `PR #2 · open · ${status}, PR #1 · open · Cancelled`
        )
      } else {
        expect(container.textContent).toContain('PR #2 · open · Cancelled, PR #1 · open · success')
      }
    }
  )
})
