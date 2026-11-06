// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import type * as BranchClient from '@/runtime/runtime-git-branch-client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { BranchPicker, type BranchPickerProps } from './BranchPicker'
import { i18n } from '@/i18n/i18n'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  listRuntimeGitBranches,
  searchRuntimeRemoteBranches,
  switchRuntimeGitBranch
} from '@/runtime/runtime-git-branch-client'

vi.mock('@/runtime/runtime-git-branch-client', async (importOriginal) => ({
  ...(await importOriginal<typeof BranchClient>()),
  listRuntimeGitBranches: vi.fn(),
  searchRuntimeRemoteBranches: vi.fn(),
  switchRuntimeGitBranch: vi.fn()
}))
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

it('keeps disk blockers authoritative in the UI while agent hints stay advisory', async () => {
  vi.mocked(listRuntimeGitBranches).mockResolvedValue({
    current: 'main',
    branches: ['main', 'feature']
  })
  vi.mocked(searchRuntimeRemoteBranches).mockResolvedValue({ refs: [], truncated: false })
  vi.mocked(switchRuntimeGitBranch).mockResolvedValue({ ok: true, branch: 'feature' })
  const props: BranchPickerProps = {
    branch: 'main',
    blocker: 'Commit or discard 2 changed files before switching.',
    context: { target: { kind: 'local' }, worktreeId: 'repo::/repo', worktreePath: '/repo' },
    repoId: 'repo',
    hostId: 'local',
    hostLabel: 'This computer',
    workspaces: new Map(),
    onOpenWorkspace: vi.fn(),
    onSwitched: vi.fn(),
    agentHint: <p>Codex last reported work here.</p>
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
  expect(container.textContent).toContain('Codex last reported work here.')
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
  const recovery = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Switch to hidden'
  )
  expect(recovery?.disabled).toBe(false)
  await act(async () => recovery?.click())
  expect(switchRuntimeGitBranch).toHaveBeenLastCalledWith(
    props.context,
    { kind: 'local', name: 'hidden' },
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

it('renders a translated local-list recovery message', async () => {
  i18n.addResourceBundle(
    'de',
    'translation',
    {
      sourceControl: { branchPicker: { listFailed: 'Lokale Zweige konnten nicht geladen werden.' } }
    },
    true,
    true
  )
  await i18n.changeLanguage('de')
  vi.mocked(listRuntimeGitBranches).mockRejectedValueOnce(new Error('unreadable'))
  try {
    await act(async () =>
      root.render(
        <BranchPicker
          branch="main"
          blocker={null}
          context={{ target: { kind: 'local' }, worktreeId: 'original', worktreePath: '/repo' }}
          repoId="repo"
          hostId="local"
          hostLabel="This computer"
          workspaces={new Map()}
          onOpenWorkspace={vi.fn()}
          onSwitched={vi.fn()}
        />
      )
    )
    await act(async () => container.querySelector('button')?.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Lokale Zweige konnten nicht geladen werden.'
    )
  } finally {
    await i18n.changeLanguage('en')
  }
})

it('updates an open memoized row when the UI language changes', async () => {
  i18n.addResourceBundle(
    'de',
    'translation',
    { sourceControl: { branchPicker: { open: 'Arbeitsbereich öffnen' } } },
    true,
    true
  )
  vi.mocked(listRuntimeGitBranches).mockResolvedValueOnce({
    current: 'main',
    branches: ['held'],
    worktreePaths: { held: '/held' }
  })
  vi.mocked(searchRuntimeRemoteBranches).mockResolvedValue({ refs: [], truncated: false })
  try {
    await act(async () =>
      root.render(
        <BranchPicker
          branch="main"
          blocker={null}
          context={{ target: { kind: 'local' }, worktreeId: 'original', worktreePath: '/repo' }}
          repoId="repo"
          hostId="local"
          hostLabel="This computer"
          workspaces={new Map([['held', { id: 'held', repoId: 'repo', path: '/held' }]])}
          onOpenWorkspace={vi.fn()}
          onSwitched={vi.fn()}
        />
      )
    )
    await act(async () => container.querySelector('button')?.click())
    expect(container.textContent).toContain('Open workspace')
    await act(async () => i18n.changeLanguage('de'))
    expect(container.textContent).toContain('Arbeitsbereich öffnen')
    expect(container.textContent).not.toContain('Open workspace')
  } finally {
    await act(async () => i18n.changeLanguage('en'))
  }
})
