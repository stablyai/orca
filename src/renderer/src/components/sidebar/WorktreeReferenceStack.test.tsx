// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeReferenceStack } from './WorktreeReferenceStack'
import { WorktreeCardMetaBadges } from './WorktreeCardMetaBadges'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { referenceAttachment, referenceReview } from './workspace-reference-fixtures.test-support'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'

afterEach(cleanup)
describe('fixed workspace reference stacks', () => {
  it('preserves singleton brand/status icons without ghosts or a count', () => {
    const linear: WorkspaceAttachment = {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: 'ENG-1'
    }
    const { container } = render(
      <>
        <WorktreeReferenceStack items={[referenceAttachment()]} />
        <WorktreeReferenceStack items={[linear]} />
      </>
    )
    expect(container.querySelectorAll('[data-reference-front]')).toHaveLength(2)
    expect(container.querySelectorAll('svg')).toHaveLength(2)
    expect(container.querySelector('[data-reference-count]')).toBeNull()
    expect(container.querySelector('.workspace-reference-stack-ghost')).toBeNull()
    expect(container.textContent).toContain('Linked PR #7')
    expect(container.textContent).toContain('Linked Linear ENG-1')
    expect(container.textContent).not.toContain('1 linked')
  })
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
  it('keeps two provider cells with the same six-pixel gap and no new metadata row at twelve references', () => {
    const refs: WorkspaceAttachment[] = [
      ...Array.from({ length: 12 }, (_, index) => referenceAttachment(index + 1)),
      ...Array.from({ length: 12 }, (_, index) => ({
        provider: 'linear' as const,
        type: 'issue' as const,
        number: 0,
        identifier: `ENG-${index + 1}`
      }))
    ]
    const { container } = render(
      <WorktreeCardMetaBadges
        linkedItemCount={refs.length}
        referenceItems={refs}
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
      />
    )
    const group = container.querySelector('[data-workspace-reference-groups]')
    expect(group?.classList.contains('gap-1.5')).toBe(true)
    expect(group?.querySelectorAll('[data-workspace-reference-stack]')).toHaveLength(2)
    expect(
      Array.from(group?.querySelectorAll('[data-reference-count]') ?? []).map(
        (node) => node.textContent
      )
    ).toEqual(['12', '12'])
    expect(container.textContent).not.toContain('24 linked')
  })
})
