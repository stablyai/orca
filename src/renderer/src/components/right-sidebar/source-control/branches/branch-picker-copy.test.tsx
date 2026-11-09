// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { BranchPicker } from './BranchPicker'
import {
  listRuntimeGitBranches,
  searchRuntimeRemoteBranches,
  switchRuntimeGitBranch
} from '@/runtime/source-control/git/runtime-git-branch-client'

vi.mock('@/runtime/source-control/git/runtime-git-branch-client', () => ({
  listRuntimeGitBranches: vi.fn(),
  searchRuntimeRemoteBranches: vi.fn(),
  switchRuntimeGitBranch: vi.fn(),
  branchSwitchExistingBranch: vi.fn(() => null)
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange: (o: boolean) => void
  }) => (
    <>
      <button onClick={() => onOpenChange(true)}>Open picker</button>
      {children}
    </>
  ),
  PopoverTrigger: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
})
const container = document.createElement('div')
document.body.append(container)
let root = createRoot(container)
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.clearAllMocks()
})

it('keeps the copy button usable on the current row and out of the list keyboard', async () => {
  vi.mocked(listRuntimeGitBranches).mockResolvedValue({
    current: 'main',
    branches: ['main', 'feature']
  })
  vi.mocked(searchRuntimeRemoteBranches).mockResolvedValue({ refs: [], truncated: false })
  const onCopyBranch = vi.fn()
  await act(async () =>
    root.render(
      <BranchPicker
        branch="main"
        blocker={null}
        context={{ target: { kind: 'local' }, worktreeId: 'repo::/repo', worktreePath: '/repo' }}
        repoId="repo"
        hostId="local"
        hostLabel="This computer"
        workspaceLabel="repo"
        workspaces={new Map()}
        onOpenWorkspace={vi.fn()}
        onSwitched={vi.fn()}
        onCopyBranch={onCopyBranch}
      />
    )
  )
  await act(async () => container.querySelector('button')?.click())
  const copy = container.querySelector('[aria-label="Copy branch name"]')
  if (!(copy instanceof HTMLElement)) {
    throw new Error('Copy button missing')
  }
  // A disabled item swallows pointer events, which would leave the button unclickable.
  expect(copy.closest('[cmdk-item]')?.getAttribute('aria-disabled')).toBe('false')
  // Highlight `feature` so a leaked Enter would switch to it.
  await act(async () =>
    container
      .querySelector('[cmdk-input]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  )
  expect(container.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toBe('feature')
  await act(async () =>
    copy.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  expect(switchRuntimeGitBranch).not.toHaveBeenCalled()
  await act(async () => copy.click())
  expect(onCopyBranch).toHaveBeenCalledOnce()
  expect(switchRuntimeGitBranch).not.toHaveBeenCalled()
})
