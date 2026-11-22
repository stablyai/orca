// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import type * as BranchClient from '@/runtime/source-control/git/runtime-git-branch-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { BranchPicker, type BranchPickerProps } from './BranchPicker'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  listRuntimeGitBranches,
  searchRuntimeRemoteBranches,
  switchRuntimeGitBranch
} from '@/runtime/source-control/git/runtime-git-branch-client'

vi.mock('@/runtime/source-control/git/runtime-git-branch-client', async (importOriginal) => ({
  ...(await importOriginal<typeof BranchClient>()),
  listRuntimeGitBranches: vi.fn(),
  searchRuntimeRemoteBranches: vi.fn(),
  switchRuntimeGitBranch: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: ReactNode
    onOpenChange: (open: boolean) => void
  }) => (
    <>
      <button onClick={() => onOpenChange(true)}>Open picker</button>
      {children}
    </>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: ReactNode }) => <>{children}</>,
  CommandList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandInput: ({
    value,
    onValueChange
  }: {
    value: string
    onValueChange: (value: string) => void
  }) => <input value={value} onChange={(event) => onValueChange(event.target.value)} />,
  CommandItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled: boolean
    onSelect: () => void
  }) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  )
}))
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
const container = document.createElement('div')
let root = createRoot(container)
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.clearAllMocks()
})

it('keeps disk blockers authoritative and offers the existing branch after a collision', async () => {
  vi.mocked(listRuntimeGitBranches).mockResolvedValue({
    current: 'main',
    branches: ['main', 'feature']
  })
  vi.mocked(searchRuntimeRemoteBranches).mockResolvedValue({ refs: [], truncated: false })
  vi.mocked(switchRuntimeGitBranch).mockResolvedValue({ ok: true, branch: 'feature' })
  const props: BranchPickerProps = {
    branch: 'main',
    blocker: 'Commit or discard 2 changed files before switching.',
    dirtyOnlyBlocker: true,
    context: { target: { kind: 'local' }, worktreeId: 'repo::/repo', worktreePath: '/repo' },
    repoId: 'repo',
    hostId: 'local',
    hostLabel: 'This computer',
    workspaceLabel: 'repo',
    workspaces: new Map(),
    onOpenWorkspace: vi.fn(),
    onSwitched: vi.fn()
  }
  await act(async () => root.render(<BranchPicker {...props} />))
  await act(async () => container.querySelector('button')?.click())
  const feature = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'feature'
  )
  expect(feature?.disabled).toBe(true)
  await act(async () => feature?.click())
  expect(switchRuntimeGitBranch).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Commit or discard 2 changed files')
  await act(async () => root.render(<BranchPicker {...props} blocker={null} />))
  expect(feature?.disabled).toBe(false)
  await act(async () => feature?.click())
  expect(switchRuntimeGitBranch).toHaveBeenCalledWith(
    props.context,
    { kind: 'local', name: 'feature' },
    'This computer'
  )
  expect(props.onSwitched).toHaveBeenCalledOnce()
  vi.mocked(switchRuntimeGitBranch).mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'collision',
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'A local branch exists.',
        data: { existingBranch: 'hidden' }
      }
    })
  )
  await act(async () => container.querySelector('button')?.click())
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'feature')
      ?.click()
  )
  const recovery = vi.mocked(toast.error).mock.lastCall?.[1]?.action
  expect(recovery).toMatchObject({ label: 'Switch to hidden' })
  if (!recovery || typeof recovery !== 'object' || !('onClick' in recovery)) {
    throw new Error('Collision toast has no recovery action')
  }
  const toastHost = document.createElement('div')
  const toastRoot = createRoot(toastHost)
  await act(async () => toastRoot.render(<button onClick={recovery.onClick}>Recover</button>))
  await act(async () => toastHost.querySelector('button')?.click())
  await act(async () => toastRoot.unmount())
  expect(switchRuntimeGitBranch).toHaveBeenLastCalledWith(
    props.context,
    { kind: 'local', name: 'hidden' },
    'This computer'
  )
  await act(async () => root.render(<BranchPicker {...props} />))
  await act(async () => container.querySelector('button')?.click())
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('Branch search input missing')
  }
  await act(async () => fireEvent.change(input, { target: { value: 'draft' } }))
  const create = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Create branch draft from main'
  )
  expect(create?.disabled).toBe(false)
  expect(container.textContent).toContain('Commit or discard 2 changed files')
  await act(async () =>
    root.render(<BranchPicker {...props} dirtyOnlyBlocker={false} blocker="Finish the merge." />)
  )
  expect(create?.disabled).toBe(true)
  await act(async () => root.render(<BranchPicker {...props} />))
  await act(async () => create?.click())
  expect(switchRuntimeGitBranch).toHaveBeenLastCalledWith(
    props.context,
    { kind: 'new', name: 'draft' },
    'This computer'
  )
})

it('delivers the original workspace outcome after the picker unmounts', async () => {
  vi.mocked(listRuntimeGitBranches).mockResolvedValue({ current: 'main', branches: ['feature'] })
  let finish: ((result: { ok: true; branch: string; warning: string }) => void) | undefined
  vi.mocked(switchRuntimeGitBranch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onSwitched = vi.fn()
  await act(async () =>
    root.render(
      <BranchPicker
        branch="main"
        blocker={null}
        context={{ target: { kind: 'local' }, worktreeId: 'original', worktreePath: '/repo' }}
        repoId="repo"
        hostId="local"
        hostLabel="This computer"
        workspaceLabel="repo"
        workspaces={new Map()}
        onOpenWorkspace={vi.fn()}
        onSwitched={onSwitched}
      />
    )
  )
  await act(async () => container.querySelector('button')?.click())
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'feature')
      ?.click()
  )
  await act(async () => root.render(<p>Another workspace</p>))
  await act(async () => finish?.({ ok: true, branch: 'feature', warning: 'Files left behind.' }))
  expect(onSwitched).toHaveBeenCalledWith('Files left behind.')
})
