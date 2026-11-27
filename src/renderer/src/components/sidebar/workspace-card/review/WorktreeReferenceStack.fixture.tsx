import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { WorktreeCardMetaBadges } from '../metadata/WorktreeCardMetaBadges'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import type {
  WorkspaceReferenceDetails,
  WorkspaceReferenceDetailsMap
} from './workspace-reference-details'

const cases: {
  label: string
  provider: WorkspaceAttachment['provider']
  type: WorkspaceAttachment['type']
  count: number
}[] = [
  { label: 'One linked task', provider: 'linear', type: 'issue', count: 1 },
  { label: 'Two linked tasks', provider: 'linear', type: 'issue', count: 2 },
  { label: 'Twelve linked tasks', provider: 'linear', type: 'issue', count: 12 },
  { label: 'Two Jira tasks', provider: 'jira', type: 'issue', count: 2 },
  { label: 'Two linked issues', provider: 'github', type: 'issue', count: 2 },
  { label: 'Two linked reviews', provider: 'github', type: 'pr', count: 2 }
]
export const linkedCounts = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      {cases.map(({ label, provider, type, count }) => (
        <div key={label} className="flex h-12 items-center gap-2 px-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <WorktreeCardMetaBadges
            issue={null}
            linearIssue={null}
            review={null}
            comment={null}
            linkedItemCount={count}
            referenceItems={Array.from({ length: count }, (_, index) => ({
              provider,
              type,
              number: index + 1,
              identifier: `ENG-${index + 1}`,
              url: `https://example.com/linked/${index + 1}`
            }))}
          />
        </div>
      ))}
    </div>
  )
})

type ReviewState = Pick<NonNullable<WorkspaceReferenceDetails['review']>, 'state' | 'status'>
const MERGED: ReviewState = { state: 'merged', status: 'success' }
const FAILING: ReviewState = { state: 'open', status: 'failure' }
const RUNNING: ReviewState = { state: 'open', status: 'pending' }
const PASSING: ReviewState = { state: 'open', status: 'success' }
const DRAFT: ReviewState = { state: 'draft', status: 'success' }
const CLOSED: ReviewState = { state: 'closed', status: 'neutral' }

function peekFixture(states: ReviewState[]) {
  const items: WorkspaceAttachment[] = states.map((_, index) => ({
    provider: 'github',
    type: 'pr',
    number: 4810 + index,
    url: `https://github.com/example/sample/pull/${4810 + index}`
  }))
  const details: WorkspaceReferenceDetailsMap = Object.fromEntries(
    items.map((item, index) => [
      getWorkspaceAttachmentKey(item),
      {
        title:
          index === 0
            ? 'Keep the sidebar reference column aligned when a workspace links many reviews'
            : `Sample change ${item.number}`,
        url: item.url!,
        review: { provider: 'github', number: item.number, title: '', ...states[index] }
      }
    ])
  )
  return defineFixture({
    width: 240,
    render: () => (
      <div className="h-80 bg-worktree-sidebar p-1 text-worktree-sidebar-foreground">
        <div className="flex h-9 items-center gap-2 px-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate">a-very-long-workspace-name-that-truncates</span>
          <WorktreeCardMetaBadges
            issue={null}
            linearIssue={null}
            review={null}
            comment={null}
            linkedItemCount={items.length}
            referenceItems={items}
            referenceDetails={details}
          />
          <span className="text-[11px] text-muted-foreground">9m</span>
        </div>
      </div>
    ),
    // Keyboard focus opens the peek, as Tab would.
    interact: async (frame) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      frame.querySelector<HTMLElement>('[data-workspace-reference-stack]')?.focus()
    }
  })
}

export const peekMergedAndFailing = peekFixture([MERGED, FAILING])
export const peekThreeMixed = peekFixture([MERGED, FAILING, PASSING])
export const peekTenMixed = peekFixture([
  FAILING,
  RUNNING,
  PASSING,
  DRAFT,
  MERGED,
  MERGED,
  CLOSED,
  PASSING,
  MERGED,
  CLOSED
])
