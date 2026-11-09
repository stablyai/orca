// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { makeWorktree } from '../../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../../store/repos/repo.test-fixture'
import { useChecksPanelTerminalWorktree } from './use-checks-panel-terminal-worktree'

const initialAppState = useAppStore.getInitialState()

const REPO_ID = 'repo1'
const PARENT_PATH = '/repo1'
const CHILD_PATH = '/repo1/packages/app'
const PARENT_ID = `${REPO_ID}::${PARENT_PATH}`
const CHILD_ID = `${REPO_ID}::${CHILD_PATH}`
const TERMINAL_CWD_POLL_MS = 4000

const repo: Repo = { ...TEST_REPO, kind: 'git', connectionId: null }
const parentWorktree: Worktree = makeWorktree({ id: PARENT_ID, repoId: REPO_ID, path: PARENT_PATH })
const childWorktree: Worktree = makeWorktree({ id: CHILD_ID, repoId: REPO_ID, path: CHILD_PATH })

const getCwdMock = vi.fn<(id: string) => Promise<string>>()

const roots: Root[] = []
let latest: ReturnType<typeof useChecksPanelTerminalWorktree> | null = null

function HookProbe(props: {
  defaultActiveWorktree: Worktree | null
  isPanelVisible: boolean
}): null {
  latest = useChecksPanelTerminalWorktree({
    defaultActiveWorktree: props.defaultActiveWorktree,
    isPanelVisible: props.isPanelVisible
  })
  return null
}

async function renderHook(
  defaultActiveWorktree: Worktree | null,
  isPanelVisible = true
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { defaultActiveWorktree, isPanelVisible }))
  })
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function runNextCwdPoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TERMINAL_CWD_POLL_MS)
  })
  await flushMicrotasks()
}

beforeEach(() => {
  vi.useFakeTimers()
  getCwdMock.mockReset().mockResolvedValue('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = { pty: { getCwd: getCwdMock } }

  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    activeWorktreeId: PARENT_ID,
    worktreesByRepo: { [REPO_ID]: [parentWorktree, childWorktree] },
    repos: [repo],
    activeTabId: 'tab-1',
    ptyIdsByTabId: { 'tab-1': ['pty-1'] }
  } as Partial<AppState>)
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  useAppStore.setState(initialAppState, true)
  vi.useRealTimers()
})

describe('useChecksPanelTerminalWorktree', () => {
  it('retains the last resolved worktree when a later cwd poll returns empty', async () => {
    getCwdMock.mockResolvedValueOnce(`${CHILD_PATH}/src`).mockResolvedValueOnce('')

    await renderHook(parentWorktree)
    await flushMicrotasks()

    expect(latest?.worktree).toBe(childWorktree)

    await runNextCwdPoll()

    expect(getCwdMock).toHaveBeenCalledTimes(2)
    expect(latest?.worktree).toBe(childWorktree)
  })

  it('does not retain a prior terminal cwd when the active terminal changes', async () => {
    getCwdMock.mockResolvedValueOnce(`${CHILD_PATH}/src`).mockResolvedValueOnce('')

    await renderHook(parentWorktree)
    await flushMicrotasks()

    expect(latest?.worktree).toBe(childWorktree)

    await act(async () => {
      useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-2'] } } as Partial<AppState>)
    })
    await flushMicrotasks()

    expect(getCwdMock).toHaveBeenCalledTimes(2)
    expect(getCwdMock).toHaveBeenLastCalledWith('pty-2')
    expect(latest?.worktree).toBe(parentWorktree)
  })

  it('follows a local-host worktree that overrides its runtime repo host', async () => {
    const RUNTIME_REPO_ID = 'runtimeRepo'
    const runtimeRepo: Repo = {
      ...TEST_REPO,
      id: RUNTIME_REPO_ID,
      path: '/runtime-repo',
      kind: 'git',
      connectionId: null,
      executionHostId: 'runtime:env-1'
    }
    // hostId 'local' overrides the runtime repo owner for this worktree.
    const localOnRuntime = makeWorktree({
      id: `${RUNTIME_REPO_ID}::/runtime-repo/app`,
      repoId: RUNTIME_REPO_ID,
      path: '/runtime-repo/app',
      hostId: 'local'
    })
    useAppStore.setState({
      worktreesByRepo: { [REPO_ID]: [parentWorktree], [RUNTIME_REPO_ID]: [localOnRuntime] },
      repos: [repo, runtimeRepo]
    } as Partial<AppState>)
    getCwdMock.mockResolvedValue('/runtime-repo/app/src')

    await renderHook(parentWorktree)
    await flushMicrotasks()

    expect(latest?.worktree).toBe(localOnRuntime)
  })

  it('does not match an SSH worktree that shares the local cwd path', async () => {
    // Only an SSH worktree matches this local path; removing host filtering must fail instead of surfacing its PR.
    const SSH_REPO_ID = 'sshRepo'
    const SSH_PATH = '/shared/project'
    const sshRepo: Repo = {
      ...TEST_REPO,
      id: SSH_REPO_ID,
      path: SSH_PATH,
      kind: 'git',
      connectionId: 'ssh-target-1'
    }
    const sshWorktree = makeWorktree({
      id: `${SSH_REPO_ID}::${SSH_PATH}`,
      repoId: SSH_REPO_ID,
      path: SSH_PATH
    })
    useAppStore.setState({
      worktreesByRepo: { [REPO_ID]: [parentWorktree, childWorktree], [SSH_REPO_ID]: [sshWorktree] },
      repos: [repo, sshRepo]
    } as Partial<AppState>)
    getCwdMock.mockResolvedValue(`${SSH_PATH}/src`)

    await renderHook(parentWorktree)
    await flushMicrotasks()

    expect(latest?.worktree).toBe(parentWorktree)
  })
})
