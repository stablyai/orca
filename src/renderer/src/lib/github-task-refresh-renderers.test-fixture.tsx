import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
export let fieldsRenders = 0
export const GHEditSectionTopColumns = (p: {
  item: GitHubWorkItem
  localAssignees: string[]
  localLabels: string[]
  isLabelsPending: boolean
  onLabelToggle: (label: string) => void
  onAssigneeToggle: (login: string) => void
}) => (
  <>
    <output data-assignees data-render={++fieldsRenders}>
      {p.localAssignees.join(',')}
    </output>
    <output data-editor-item>{JSON.stringify(p.item)}</output>
    <output data-labels>{p.localLabels.join(',')}</output>
    <button disabled={p.isLabelsPending} onClick={() => p.onLabelToggle('bug')}>
      Add bug
    </button>
    <button onClick={() => p.onAssigneeToggle('bob')}>Add Bob</button>
  </>
)
export const ConversationTabDescription = (p: {
  item: GitHubWorkItem
  body: string
  resolvedBodyDraft: string
  setBodyDraft: (v: string) => void
  setBodyEditing: (v: boolean) => void
  onSaveBody: () => void
}) => (
  <>
    <output data-body>{p.body}</output>
    <output data-conversation-item>{JSON.stringify(p.item)}</output>
    <input
      aria-label="Body draft"
      value={p.resolvedBodyDraft}
      onChange={(e) => {
        p.setBodyEditing(true)
        p.setBodyDraft(e.target.value)
      }}
    />
    <button onClick={p.onSaveBody}>Save body</button>
  </>
)
export const ConversationTabActivity = (p: { comments: { body: string }[] }) => (
  <output data-comments>{p.comments.map((c) => c.body).join(',')}</output>
)
export const GitHubMarkdownComposer = (p: { value: string; onChange: (value: string) => void }) => (
  <input aria-label="Comment draft" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
)
