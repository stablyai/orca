// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/types'
import { useSetupScriptPromptRevalidation } from './useSetupScriptPromptRevalidation'
import type { SetupScriptPromptState } from './setup-script-prompt-render-state'
import { getRepoHostIdentityForParts } from '@/store/slices/repo-host-identity'

const GIT_REPO = { id: 'repo-1', kind: 'git' } as unknown as Repo
type OkSetupScriptPromptState = Extract<SetupScriptPromptState, { status: 'ok' }>

function missingSetup(repoId: string, hostId = 'local'): OkSetupScriptPromptState {
  return {
    status: 'ok',
    repoId,
    repoHostIdentity: getRepoHostIdentityForParts(repoId, hostId),
    hasEffectiveSetup: false,
    hasSharedHooks: true,
    candidate: null
  }
}

function effectiveSetup(repoId: string): OkSetupScriptPromptState {
  return { ...missingSetup(repoId), hasEffectiveSetup: true }
}

function inspectionError(repoId: string, hostId = 'local'): SetupScriptPromptState {
  return {
    status: 'error',
    repoId,
    repoHostIdentity: getRepoHostIdentityForParts(repoId, hostId)
  }
}

const RUNTIME_ENVIRONMENT_ID = 'env-1'
const RUNTIME_REPO = {
  id: 'repo-1',
  kind: 'git',
  executionHostId: `runtime:${RUNTIME_ENVIRONMENT_ID}`
} as unknown as Repo

async function setRuntimeConnectionGeneration(connectionGeneration: number): Promise<void> {
  await act(async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [RUNTIME_ENVIRONMENT_ID, { status: null, checkedAt: 0, connectionGeneration }]
      ])
    })
  })
}

type HarnessProps = {
  activeRepo: Repo | null
  isDismissed: boolean
  sidebarOpen: boolean
  promptState: SetupScriptPromptState | null
  requestRevalidation: () => void
}

function Harness(props: HarnessProps): null {
  useSetupScriptPromptRevalidation(props)
  return null
}

const roots: Root[] = []

async function render(props: HarnessProps): Promise<(next: HarnessProps) => Promise<void>> {
  const container = document.createElement('div')
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<Harness {...props} />)
  })
  return async (next: HarnessProps) => {
    await act(async () => {
      root.render(<Harness {...next} />)
    })
  }
}

async function dispatchWindowFocus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
}

async function setActiveWorktree(worktreeId: string | null): Promise<void> {
  await act(async () => {
    useAppStore.setState({ activeWorktreeId: worktreeId })
  })
}

describe('useSetupScriptPromptRevalidation', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState({ activeWorktreeId: 'worktree-1' })
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => act(() => root.unmount()))
    document.body.replaceChildren()
    useAppStore.setState({ activeWorktreeId: null, runtimeStatusByEnvironmentId: new Map() })
    vi.clearAllMocks()
  })

  it('re-inspects on window focus while the prompt shows no effective setup', async () => {
    const requestRevalidation = vi.fn()
    await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1'),
      requestRevalidation
    })

    await dispatchWindowFocus()

    expect(requestRevalidation).toHaveBeenCalledTimes(1)
  })

  it('does not re-inspect on window focus once setup is effective', async () => {
    const requestRevalidation = vi.fn()
    await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: effectiveSetup('repo-1'),
      requestRevalidation
    })

    await dispatchWindowFocus()

    expect(requestRevalidation).not.toHaveBeenCalled()
  })

  it('does not listen for focus while the sidebar is closed', async () => {
    const requestRevalidation = vi.fn()
    await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: false,
      promptState: missingSetup('repo-1'),
      requestRevalidation
    })

    await dispatchWindowFocus()

    expect(requestRevalidation).not.toHaveBeenCalled()
  })

  it('does not re-inspect when prompt state belongs to another host with the same repo id', async () => {
    const requestRevalidation = vi.fn()
    await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1', 'runtime:windows'),
      requestRevalidation
    })

    await dispatchWindowFocus()
    await setActiveWorktree('worktree-2')

    expect(requestRevalidation).not.toHaveBeenCalled()
  })

  it('re-inspects when a worktree activates while the prompt shows no effective setup', async () => {
    const requestRevalidation = vi.fn()
    // Mirror the card's real lifecycle: promptState is null on mount, so the
    // activation effect does not fire until a negative result has been cached.
    const rerender = await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: null,
      requestRevalidation
    })
    await rerender({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1'),
      requestRevalidation
    })
    expect(requestRevalidation).not.toHaveBeenCalled()

    await setActiveWorktree('worktree-2')

    expect(requestRevalidation).toHaveBeenCalledTimes(1)
  })

  it('does not re-inspect on worktree activation once setup is effective', async () => {
    const requestRevalidation = vi.fn()
    const rerender = await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: null,
      requestRevalidation
    })
    await rerender({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: effectiveSetup('repo-1'),
      requestRevalidation
    })

    await setActiveWorktree('worktree-2')

    expect(requestRevalidation).not.toHaveBeenCalled()
  })

  it('re-inspects on window focus after a failed inspection', async () => {
    const requestRevalidation = vi.fn()
    await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: inspectionError('repo-1'),
      requestRevalidation
    })

    await dispatchWindowFocus()

    expect(requestRevalidation).toHaveBeenCalledTimes(1)
  })

  it('replays a worktree activation that landed while the prompt state was unsettled', async () => {
    const requestRevalidation = vi.fn()
    const rerender = await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1'),
      requestRevalidation
    })
    // The card nulls its state for the whole inspection round trip, so the
    // activation lands while nothing is revalidatable.
    await rerender({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: null,
      requestRevalidation
    })
    await setActiveWorktree('worktree-2')
    expect(requestRevalidation).not.toHaveBeenCalled()

    await rerender({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1'),
      requestRevalidation
    })

    expect(requestRevalidation).toHaveBeenCalledTimes(1)
  })

  it('re-inspects when the repo runtime reconnects', async () => {
    const requestRevalidation = vi.fn()
    await setRuntimeConnectionGeneration(1)
    await render({
      activeRepo: RUNTIME_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1', `runtime:${RUNTIME_ENVIRONMENT_ID}`),
      requestRevalidation
    })
    expect(requestRevalidation).not.toHaveBeenCalled()

    await setRuntimeConnectionGeneration(2)

    expect(requestRevalidation).toHaveBeenCalledTimes(1)
  })

  it('ignores a reconnect of a runtime that does not own the repo', async () => {
    const requestRevalidation = vi.fn()
    await setRuntimeConnectionGeneration(1)
    await render({
      activeRepo: GIT_REPO,
      isDismissed: false,
      sidebarOpen: true,
      promptState: missingSetup('repo-1'),
      requestRevalidation
    })

    await setRuntimeConnectionGeneration(2)

    expect(requestRevalidation).not.toHaveBeenCalled()
  })
})
