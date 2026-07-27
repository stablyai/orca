// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import type { Repo } from '../../../../shared/types'
import { useSetupScriptPromptRevalidation } from './useSetupScriptPromptRevalidation'

const GIT_REPO = { id: 'repo-1', kind: 'git' } as unknown as Repo

function missingSetup(repoId: string): SetupScriptPromptInspection {
  return { status: 'ok', repoId, hasEffectiveSetup: false, hasSharedHooks: true, candidate: null }
}

function effectiveSetup(repoId: string): SetupScriptPromptInspection {
  return { status: 'ok', repoId, hasEffectiveSetup: true, hasSharedHooks: true, candidate: null }
}

type HarnessProps = {
  activeRepo: Repo | null
  isDismissed: boolean
  sidebarOpen: boolean
  promptState: SetupScriptPromptInspection | null
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
    useAppStore.setState({ activeWorktreeId: null })
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
})
