// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  install: vi.fn(),
  installLink: vi.fn(),
  clipboard: vi.fn()
}))
vi.mock('@/lib/orca-cloud/use-orca-cloud-repo-access', () => ({
  fetchOrcaCloudRepoAccess: mocks.access
}))
vi.mock('@/lib/orca-cloud/cloud-setup-notice-actions', () => ({
  openOrcaGitHubAppInstall: mocks.install
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  cloudWorkspaceApi: () => ({ gitHubInstallLink: mocks.installLink })
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import {
  CLONE_ACCESS_WAIT_MS,
  copyOwnerRequest,
  githubRepoUrlFor,
  useCloneAccessHandoff
} from './use-clone-access-handoff'

const REPO = 'stablyai/orca-plugins'

function answer(access: string) {
  return { access, owner: 'stablyai', repo: `https://github.com/${REPO}` }
}

function setup() {
  const onRetry = vi.fn()
  const hook = renderHook(() => useCloneAccessHandoff({ repoName: REPO, enabled: true, onRetry }))
  return { hook, onRetry }
}

describe('CLONE-ACCESS-ERROR: a clone GitHub refused', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText: mocks.clipboard } }
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
  })

  it('asks GitHub first: missing access offers the fix; reachable means try again', async () => {
    mocks.access.mockResolvedValueOnce(answer('missing'))
    const missing = setup()
    await waitFor(() => expect(missing.hook.result.current.phase).toBe('missing'))
    expect(mocks.access).toHaveBeenCalledWith(`https://github.com/${REPO}`, { force: true })
    missing.hook.unmount()
    mocks.access.mockResolvedValueOnce(answer('granted'))
    const reachable = setup()
    await waitFor(() => expect(reachable.hook.result.current.phase).toBe('reachable'))
    // Reachable at first look is news, not a handoff: nothing starts on its own.
    expect(reachable.onRetry).not.toHaveBeenCalled()
  })

  it('Give Orca access opens the install page, waits, and starts again once access lands', async () => {
    mocks.access.mockResolvedValueOnce(answer('missing'))
    mocks.install.mockResolvedValue(true)
    const { hook, onRetry } = setup()
    await waitFor(() => expect(hook.result.current.phase).toBe('missing'))
    act(() => hook.result.current.giveAccess())
    await waitFor(() => expect(hook.result.current.phase).toBe('waiting'))
    expect(mocks.install).toHaveBeenCalledWith(`https://github.com/${REPO}`)
    // Back from GitHub before the webhook: still waiting.
    mocks.access.mockResolvedValueOnce(answer('missing'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(2))
    expect(hook.result.current.phase).toBe('waiting')
    expect(onRetry).not.toHaveBeenCalled()
    mocks.access.mockResolvedValueOnce(answer('granted'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce())
  })

  it('an install that became a request for an owner says who to ask, and an approval starts again', async () => {
    mocks.access.mockResolvedValueOnce(answer('missing'))
    mocks.install.mockResolvedValue(true)
    const { hook, onRetry } = setup()
    await waitFor(() => expect(hook.result.current.phase).toBe('missing'))
    act(() => hook.result.current.giveAccess())
    await waitFor(() => expect(hook.result.current.phase).toBe('waiting'))
    mocks.access.mockResolvedValueOnce(answer('requested'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(hook.result.current.phase).toBe('requested'))
    mocks.access.mockResolvedValueOnce(answer('granted'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce())
  })

  it('waiting gives up after a while, and the button comes back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.access.mockResolvedValue(answer('missing'))
    mocks.install.mockResolvedValue(true)
    const { hook } = setup()
    await waitFor(() => expect(hook.result.current.phase).toBe('missing'))
    act(() => hook.result.current.giveAccess())
    await waitFor(() => expect(hook.result.current.phase).toBe('waiting'))
    await act(async () => {
      vi.advanceTimersByTime(CLONE_ACCESS_WAIT_MS)
    })
    await waitFor(() => expect(hook.result.current.phase).toBe('missing'))
  })

  it('the request for an owner carries the install link that preselects the repository', async () => {
    mocks.installLink.mockResolvedValue({ ok: true, value: 'https://github.com/apps/orca/install' })
    await copyOwnerRequest(REPO, githubRepoUrlFor(REPO))
    expect(mocks.installLink).toHaveBeenCalledWith({ repoUrl: `https://github.com/${REPO}` })
    const [text] = mocks.clipboard.mock.calls[0] ?? []
    expect(text).toContain(REPO)
    expect(text).toContain('https://github.com/apps/orca/install')
  })

  it('names only owner/repo as a GitHub repository', () => {
    expect(githubRepoUrlFor('stablyai/orca')).toBe('https://github.com/stablyai/orca')
    expect(githubRepoUrlFor('My project')).toBeNull()
  })
})
