// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitPullRequest } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { SourceControlCustomAction } from '../../../../../shared/source-control-custom-actions'
import { PullRequestPageHeader } from './header'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const workItem: GitHubWorkItem = {
  id: 'pr-123',
  type: 'pr',
  number: 123,
  title: 'Add retry',
  state: 'open',
  url: 'https://github.com/acme/api/pull/123',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octocat',
  repoId: 'repo-1'
}

const reviewAction: SourceControlCustomAction = {
  id: 'review',
  label: 'Review',
  commandInputTemplate: '/code-review {prUrl} xhigh --comment with codex.'
}

describe('PullRequestPageHeader custom actions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  async function renderAndOpenMenu(props: {
    customActions: readonly SourceControlCustomAction[]
    customActionsBusy?: boolean
    onRunCustomAction?: (action: SourceControlCustomAction) => void
    onManageCustomActions?: () => void
  }): Promise<HTMLElement[]> {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <PullRequestPageHeader
            workItem={workItem}
            displayWorkItem={null}
            backLabel="Pull requests"
            onClose={vi.fn()}
            linkCopied={false}
            setLinkCopyButtonRef={vi.fn()}
            onCopyLink={vi.fn()}
            hasAttachedWorkspace={false}
            attachedWorkspaceLabel={null}
            localState="open"
            Icon={GitPullRequest}
            onOpenOrUsePR={vi.fn()}
            onUseWorkItem={vi.fn()}
            customActions={props.customActions}
            customActionsBusy={props.customActionsBusy ?? false}
            onRunCustomAction={props.onRunCustomAction ?? vi.fn()}
            onManageCustomActions={props.onManageCustomActions ?? vi.fn()}
          />
        </TooltipProvider>
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More PR workspace actions"]'
    )
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })
    return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  }

  it('lists custom actions first and runs the chosen one', async () => {
    const onRunCustomAction = vi.fn()
    const items = await renderAndOpenMenu({ customActions: [reviewAction], onRunCustomAction })

    expect(items.map((item) => item.textContent)).toEqual([
      'Review',
      'Open on GitHub',
      'Manage custom actions…'
    ])

    await act(async () => {
      items[0].click()
    })
    expect(onRunCustomAction).toHaveBeenCalledWith(reviewAction)
  })

  it('offers to add an action when none are defined', async () => {
    const onManageCustomActions = vi.fn()
    const items = await renderAndOpenMenu({ customActions: [], onManageCustomActions })

    expect(items.map((item) => item.textContent)).toEqual(['Open on GitHub', 'Add custom action…'])

    await act(async () => {
      items[1].click()
    })
    expect(onManageCustomActions).toHaveBeenCalledTimes(1)
  })

  it('disables custom actions while one is starting', async () => {
    const items = await renderAndOpenMenu({
      customActions: [reviewAction],
      customActionsBusy: true
    })

    expect(items[0].getAttribute('aria-disabled')).toBe('true')
  })
})
