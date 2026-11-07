// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => ({ update: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runWorkItemBodyUpdate: mocks.update
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: () => {} }) }
}))
vi.mock('@/lib/pr-bot-author-overrides', () => ({ usePRBotAuthorOverrides: () => ({}) }))
vi.mock('./conversation-tab-activity', () => ({ ConversationTabActivity: () => null }))
vi.mock('./conversation-tab-pr-sidebar', () => ({ ConversationTabPRSidebar: () => null }))
vi.mock('./gh-comment-composer', () => ({ GHCommentComposer: () => null }))
vi.mock('@/components/github/GitHubMarkdownComposer', () => ({
  GitHubMarkdownComposer: ({
    value,
    onChange
  }: {
    value: string
    onChange: (value: string) => void
  }) => (
    <textarea
      aria-label="Description fixture"
      value={value}
      onInput={(event) => onChange(event.currentTarget.value)}
    />
  )
}))
import { ConversationTab } from './conversation-tab'

it('edits the canonical body after rendering its signed image source', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const body =
    '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  const noop = () => {}
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ConversationTab
            item={{
              id: 'issue:2',
              repoId: 'repo',
              number: 2,
              title: 'Image',
              type: 'issue',
              state: 'open',
              author: null,
              url: 'https://github.com/acme/widgets/issues/2',
              labels: [],
              updatedAt: ''
            }}
            repoPath="/repo"
            repoId="repo"
            body={body}
            bodyImageUrls={{
              'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
                'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
            }}
            comments={[]}
            files={[]}
            headSha={undefined}
            baseSha={undefined}
            loading={false}
            detailsLoaded
            checks={[]}
            localState="open"
            projectOrigin={undefined}
            onStateChange={noop}
            onMutated={noop}
            onChecksUpdated={noop}
            onBodyUpdated={noop}
            onCommentAdded={noop}
            onReviewersRequested={noop}
          />
        </TooltipProvider>
      )
    )
    expect(node.querySelector('img')?.src).toBe(
      'https://private-user-images.githubusercontent.com/1/image.png?jwt=TEST'
    )
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Edit description"]')?.click()
    )
    const editor = node.querySelector('textarea')!
    expect(editor.value).toBe(body)
    await act(async () => {
      editor.value = `${body}\nEdited`
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      [...node.querySelectorAll('button')].find((button) => button.textContent === 'Save')?.click()
    )
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)\nEdited'
      })
    )
  } finally {
    act(() => root.unmount())
    node.remove()
  }
})
