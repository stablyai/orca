import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { WorktreeCardMetaBadges } from '../metadata/WorktreeCardMetaBadges'

const cases: {
  label: string
  provider: WorkspaceAttachment['provider']
  type: WorkspaceAttachment['type']
  count: number
  reviewStates?: ('open' | 'merged')[]
}[] = [
  { label: 'One linked task', provider: 'linear', type: 'issue', count: 1 },
  { label: 'Two linked tasks', provider: 'linear', type: 'issue', count: 2 },
  { label: 'Twelve linked tasks', provider: 'linear', type: 'issue', count: 12 },
  { label: 'Two Jira tasks', provider: 'jira', type: 'issue', count: 2 },
  { label: 'Two linked issues', provider: 'github', type: 'issue', count: 2 },
  { label: 'Two linked reviews', provider: 'github', type: 'pr', count: 2 },
  {
    label: 'Open and merged reviews',
    provider: 'github' as const,
    type: 'pr',
    count: 3,
    reviewStates: ['open', 'merged', 'merged']
  }
]

function referenceItem(
  provider: WorkspaceAttachment['provider'],
  type: WorkspaceAttachment['type'],
  index: number
): WorkspaceAttachment {
  return {
    provider,
    type,
    number: index + 1,
    identifier: `ENG-${index + 1}`,
    url: `https://example.com/linked/${index + 1}`
  }
}
export const linkedCounts = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      {cases.map(({ label, provider, type, count, reviewStates }) => {
        const items = Array.from({ length: count }, (_, index) =>
          referenceItem(provider, type, index)
        )
        const details = reviewStates
          ? Object.fromEntries(
              items.map((item, index) => [
                getWorkspaceAttachmentKey(item),
                {
                  title: '',
                  url: item.url ?? '',
                  review: {
                    provider: 'github' as const,
                    number: item.number,
                    title: '',
                    state: reviewStates[index]
                  }
                }
              ])
            )
          : undefined
        return (
          <div key={label} className="flex h-12 items-center gap-2 px-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <WorktreeCardMetaBadges
              issue={null}
              linearIssue={null}
              review={null}
              comment={null}
              linkedItemCount={count}
              referenceItems={items}
              referenceDetails={details}
            />
          </div>
        )
      })}
    </div>
  )
})
