// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import { GHEditSection } from './gh-edit-section'
import { resetTaskPageGitHubMutationRegistryForTests } from '@/components/task-page-github-work-item-mutation-registry'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  patchWorkItem: vi.fn(),
  patchProjectRowContent: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  onMutated: vi.fn()
}))

vi.mock('@/store', () => {
  const state = {
    patchWorkItem: mocks.patchWorkItem,
    patchProjectRowContent: mocks.patchProjectRowContent,
    recordFeatureInteraction: mocks.recordFeatureInteraction,
    repos: [],
    settings: null
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})

vi.mock('@/hooks/useIssueMetadata', async () => {
  const { useImmediateMutation } = await import('@/hooks/useImmediateMutation')
  return {
    useImmediateMutation,
    useRepoLabels: () => ({ data: [] }),
    useRepoAssignees: () => ({ data: [] })
  }
})
vi.mock('@/hooks/useGitHubSlugMetadata', () => ({
  useRepoLabelsBySlug: () => ({ data: [] }),
  useRepoAssigneesBySlug: () => ({ data: [] })
}))
vi.mock('@/components/github/github-duplicate-issue-candidates', () => ({
  useGitHubDuplicateIssueCandidates: () => []
}))
vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runIssueUpdate: mocks.update
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./gh-edit-section-horizontal', () => ({ GHEditSectionHorizontal: () => null }))
vi.mock('./gh-edit-section-top-columns', () => ({
  GHEditSectionTopColumns: ({
    localAssignees,
    onAssigneeToggle,
    localState,
    localLabels,
    onStateChange,
    onLabelToggle
  }: {
    localAssignees: string[]
    onAssigneeToggle: (login: string) => void
    localState: GitHubWorkItem['state']
    localLabels: string[]
    onStateChange: (state: 'open' | 'closed') => void
    onLabelToggle: (label: string) => void
  }) => (
    <>
      <output data-field="assignees">{localAssignees.join(',')}</output>
      <output data-field="state">{localState}</output>
      <output data-field="labels">{localLabels.join(',')}</output>
      <button onClick={() => onAssigneeToggle('candidate-user')}>Assign candidate</button>
      <button onClick={() => onAssigneeToggle('original-user')}>Toggle original</button>
      <button onClick={() => onStateChange('closed')}>Close issue</button>
      <button onClick={() => onLabelToggle('candidate-label')}>Toggle label</button>
    </>
  )
}))

const item: GitHubWorkItem = {
  id: 'issue:5',
  repoId: 'registered-repo',
  type: 'issue',
  number: 5,
  title: 'Issue five',
  state: 'open',
  url: 'https://github.com/upstream/widgets/issues/5',
  labels: [],
  updatedAt: '',
  author: null
}
let root: Root
let container: HTMLDivElement

async function render(
  nextItem = item,
  assignees: string[] = [],
  projectOrigin?: GitHubItemDialogProjectOrigin
): Promise<void> {
  await act(async () => {
    root.render(
      <GHEditSection
        item={nextItem}
        repoPath={null}
        repoId={nextItem.repoId}
        projectOrigin={projectOrigin}
        localState="open"
        localLabels={[]}
        onStateChange={() => {}}
        onLabelsChange={() => {}}
        onMutated={mocks.onMutated}
        assignees={assignees}
        onUse={() => {}}
        layout="top-columns"
      />
    )
  })
}

async function click(label = 'Assign candidate'): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
}

function selected(): string | null {
  return container.querySelector('[data-field="assignees"]')?.textContent ?? null
}

let updateParentSelection: (nextItem: GitHubWorkItem) => void = () => {}

function ParentSelection({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  const [localState, setLocalState] = useState(item.state)
  const [localLabels, setLocalLabels] = useState(item.labels)
  updateParentSelection = (nextItem) => {
    setLocalState(nextItem.state)
    setLocalLabels(nextItem.labels)
  }
  return (
    <GHEditSection
      item={item}
      repoPath={null}
      repoId={item.repoId}
      projectOrigin={undefined}
      localState={localState}
      localLabels={localLabels}
      onStateChange={setLocalState}
      onLabelsChange={setLocalLabels}
      onMutated={mocks.onMutated}
      assignees={[]}
      onUse={() => {}}
      layout="top-columns"
    />
  )
}

async function renderParent(nextItem: GitHubWorkItem): Promise<void> {
  await act(async () => {
    updateParentSelection(nextItem)
    root.render(<ParentSelection item={nextItem} />)
  })
}

describe('opened issue assignee ownership', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    resetTaskPageGitHubMutationRegistryForTests()
    updateParentSelection = () => {}
    mocks.update.mockResolvedValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    resetTaskPageGitHubMutationRegistryForTests()
  })

  it('retires an optimistic selection across fork and return navigation', async () => {
    await render()
    await click()
    expect(selected()).toBe('candidate-user')
    await render(item, [])
    expect(selected()).toBe('candidate-user')

    await render({ ...item, url: 'https://github.com/fork/widgets/issues/5' }, ['fork-user'])
    expect(selected()).toBe('fork-user')
    await render(item, ['authoritative-upstream-user'])
    expect(selected()).toBe('authoritative-upstream-user')
  })

  it('does not revive an edited guard when returning from a different issue number', async () => {
    await render()
    await click()
    await render({ ...item, id: 'issue:6', number: 6 }, ['other-issue-user'])
    expect(selected()).toBe('other-issue-user')
    await render(item, ['authoritative-upstream-user'])
    expect(selected()).toBe('authoritative-upstream-user')
  })

  it.each(['Assign candidate', 'Toggle original'])(
    'does not roll a late failed %s edit into another opened issue',
    async (button) => {
      let rejectUpdate: (reason: Error) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectUpdate = reject
          })
      )
      await render(item, ['original-user'])
      await click(button)
      await render({ ...item, id: 'issue:6', number: 6 }, ['other-issue-user'])
      expect(selected()).toBe('other-issue-user')
      await act(async () => rejectUpdate(new Error('held edit failed')))
      expect(selected()).toBe('other-issue-user')
    }
  )

  it('treats another GitHub host as a distinct same-number issue', async () => {
    await render()
    await click()
    await render({ ...item, url: 'https://github.example.test/upstream/widgets/issues/5' }, [])
    expect(selected()).toBe('')
  })

  it('retires the issue edit when the same legacy id is used by a pull request', async () => {
    await render()
    await click()
    await render({ ...item, type: 'pr' }, [])
    await render(item, ['authoritative-upstream-user'])
    expect(selected()).toBe('authoritative-upstream-user')
  })

  it('preserves optimistic edits across canonical URL casing and trailing paths', async () => {
    await render()
    await click()
    await render({ ...item, url: 'https://GITHUB.COM/Upstream/Widgets/issues/5#activity' }, [])
    expect(selected()).toBe('candidate-user')
  })

  it('uses the Project row repository before an unrelated item URL', async () => {
    const projectOrigin: GitHubItemDialogProjectOrigin = {
      owner: 'upstream',
      repo: 'widgets',
      number: 5,
      type: 'issue',
      projectId: 'project',
      projectItemId: 'row',
      cacheKey: 'project-cache'
    }
    await render(item, [], projectOrigin)
    await click()
    await render(
      { ...item, url: 'https://github.com/unrelated/widgets/issues/5' },
      [],
      projectOrigin
    )
    expect(selected()).toBe('candidate-user')
    await render(item, ['fork-user'], { ...projectOrigin, owner: 'fork' })
    expect(selected()).toBe('fork-user')
  })

  it('still rolls back a failed edit while its issue remains open', async () => {
    mocks.update.mockRejectedValue(new Error('edit failed'))
    await render(item, ['original-user'])
    await click()
    expect(selected()).toBe('original-user')
    await render(item, ['refetched-user'])
    expect(selected()).toBe('refetched-user')
  })

  it('keeps a late Project-row rollback scoped to the captured row', async () => {
    const projectOrigin: GitHubItemDialogProjectOrigin = {
      owner: 'upstream',
      repo: 'widgets',
      number: 5,
      type: 'issue',
      projectId: 'project',
      projectItemId: 'upstream-row',
      cacheKey: 'upstream-cache'
    }
    let rejectUpdate: (reason: Error) => void = () => {}
    mocks.update.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpdate = reject
        })
    )
    await render(item, ['original-user'], projectOrigin)
    await click()
    await render(item, ['fork-user'], {
      ...projectOrigin,
      owner: 'fork',
      projectItemId: 'fork-row',
      cacheKey: 'fork-cache'
    })
    expect(selected()).toBe('fork-user')
    await act(async () => rejectUpdate(new Error('held Project edit failed')))
    expect(selected()).toBe('fork-user')
    expect(mocks.patchProjectRowContent).toHaveBeenLastCalledWith(
      'upstream-cache',
      'upstream-row',
      { assignees: ['original-user'] }
    )
  })

  it.each([
    { button: 'Toggle label', field: 'labels', expected: 'fork-only-label' },
    { button: 'Close issue', field: 'state', expected: 'closed' }
  ])(
    'a late failed $field edit cannot overwrite the new parent selection',
    async ({ button, field, expected }) => {
      let rejectUpdate: (reason: Error) => void = () => {}
      mocks.update.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectUpdate = reject
          })
      )
      await renderParent({ ...item, labels: ['upstream-original-label'] })
      await click(button)
      await renderParent({
        ...item,
        state: 'closed',
        url: 'https://github.com/fork/widgets/issues/5',
        labels: ['fork-only-label']
      })
      expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(expected)
      await act(async () => rejectUpdate(new Error('held edit failed')))
      expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(expected)
      expect(mocks.patchWorkItem).toHaveBeenLastCalledWith(
        item.id,
        field === 'labels' ? { labels: ['upstream-original-label'] } : { state: 'open' },
        item.repoId,
        {
          sourceContext: undefined,
          ownerRepo: { owner: 'upstream', repo: 'widgets', host: 'github.com' }
        }
      )
    }
  )

  it.each([
    { button: 'Toggle label', field: 'labels', expected: 'upstream-original-label' },
    { button: 'Close issue', field: 'state', expected: 'open' }
  ])(
    'a same-item failed $field edit still restores its prior parent value',
    async ({ button, field, expected }) => {
      mocks.update.mockRejectedValue(new Error('same issue edit failed'))
      await renderParent({ ...item, labels: ['upstream-original-label'] })
      await click(button)
      expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(expected)
    }
  )
})
