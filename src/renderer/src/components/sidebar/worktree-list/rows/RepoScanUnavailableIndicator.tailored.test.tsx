// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { RepoScanUnavailableIndicator } from './RepoScanUnavailableIndicator'

type TerminalHandlers = {
  onCommandFinished: ((exitCode: number | null) => void) | null
  onOpenChange: ((open: boolean) => void) | null
}

const mocks = vi.hoisted((): TerminalHandlers => ({ onCommandFinished: null, onOpenChange: null }))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: (): NodeJS.Platform => 'darwin'
}))

vi.mock('@/components/onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    description,
    worktreeId,
    onCommandFinished
  }: {
    command: string
    description?: string
    worktreeId?: string
    onCommandFinished?: (exitCode: number | null) => void
  }) => {
    mocks.onCommandFinished = onCommandFinished ?? null
    return (
      <div data-testid="fix-terminal" data-command={command} data-worktree-id={worktreeId}>
        {description}
      </div>
    )
  }
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => {
    mocks.onOpenChange = onOpenChange ?? null
    return <>{children}</>
  },
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

const initialState = useAppStore.getInitialState()
const roots: Root[] = []

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

const asStoreFetch = (mock: unknown): AppState['fetchWorktrees'] =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store's fetchWorktrees is overloaded (direct-SSH result and boolean forms); these tests only drive the boolean form.
  mock as AppState['fetchWorktrees']

function xcodeFailure(repoId: string) {
  return makeDetectedResult(repoId, [], {
    authoritative: false,
    source: 'metadata-fallback',
    unavailableReason: 'sudo xcodebuild -license: agree to the Xcode license'
  })
}

async function renderWithRepo(repo: Repo): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<RepoScanUnavailableIndicator repo={repo} />)
  })
  return container
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  for (const node of container.querySelectorAll('button')) {
    if (node instanceof HTMLButtonElement && node.textContent?.includes(label)) {
      return node
    }
  }
  return null
}

describe('RepoScanUnavailableIndicator tailored failures', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState(initialState, true)
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount())
    }
    document.body.innerHTML = ''
    useAppStore.setState(initialState, true)
    mocks.onCommandFinished = null
    mocks.onOpenChange = null
    vi.clearAllMocks()
  })

  it('renders the Xcode license fix and expands the setup terminal on request', async () => {
    const repo = makeRepo({ connectionId: null })
    useAppStore.setState({
      repos: [repo],
      fetchWorktrees: asStoreFetch(vi.fn(async () => true)),
      detectedWorktreesByRepo: { [repo.id]: xcodeFailure(repo.id) }
    })

    const container = await renderWithRepo(repo)

    expect(container.textContent).toContain('Xcode license needs acceptance')
    expect(container.textContent).toContain('sudo xcodebuild -license accept')
    expect(container.querySelector('[data-testid="fix-terminal"]')).toBeNull()
    await act(async () => {
      findButton(container, 'Open terminal with fix')?.click()
    })
    const terminal = container.querySelector('[data-testid="fix-terminal"]')
    expect(terminal?.getAttribute('data-command')).toBe('sudo xcodebuild -license accept')
    expect(terminal?.getAttribute('data-worktree-id')).toContain('repo-1')
  })

  it('falls back to plain tailored text for SSH owners', async () => {
    const repo = makeRepo({ id: 'repo-ssh', connectionId: 'target-1' })
    useAppStore.setState({
      repos: [repo],
      fetchWorktrees: asStoreFetch(vi.fn(async () => true)),
      detectedWorktreesByRepo: { [repo.id]: xcodeFailure(repo.id) }
    })

    const container = await renderWithRepo(repo)

    expect(container.textContent).toContain('Xcode license needs acceptance')
    expect(container.textContent).toContain('run the fix there')
    expect(findButton(container, 'Open terminal with fix')).toBeNull()
  })

  it('collapses the fix terminal when the panel closes', async () => {
    const repo = makeRepo({ connectionId: null })
    useAppStore.setState({
      repos: [repo],
      fetchWorktrees: asStoreFetch(vi.fn(async () => true)),
      detectedWorktreesByRepo: { [repo.id]: xcodeFailure(repo.id) }
    })

    const container = await renderWithRepo(repo)
    await act(async () => {
      findButton(container, 'Open terminal with fix')?.click()
    })
    expect(container.querySelector('[data-testid="fix-terminal"]')).not.toBeNull()

    await act(async () => {
      mocks.onOpenChange?.(false)
    })

    expect(container.querySelector('[data-testid="fix-terminal"]')).toBeNull()
    expect(findButton(container, 'Open terminal with fix')).not.toBeNull()
  })

  it('re-runs the scan when the fix command exits cleanly', async () => {
    const repo = makeRepo({ connectionId: null })
    const fetchWorktrees = vi.fn(async () => true)
    useAppStore.setState({
      repos: [repo],
      fetchWorktrees: asStoreFetch(fetchWorktrees),
      detectedWorktreesByRepo: { [repo.id]: xcodeFailure(repo.id) }
    })

    const container = await renderWithRepo(repo)
    await act(async () => {
      findButton(container, 'Open terminal with fix')?.click()
    })
    await act(async () => {
      mocks.onCommandFinished?.(0)
    })

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
  })

  it('clears every repo blocked by the same host-wide cause after one succeeds', async () => {
    const repoA = makeRepo({ id: 'a', connectionId: null, path: '/a' })
    const repoB = makeRepo({ id: 'b', connectionId: null, path: '/b' })
    const fetchWorktrees = vi.fn(async () => true)
    useAppStore.setState({
      repos: [repoA, repoB],
      fetchWorktrees: asStoreFetch(fetchWorktrees),
      detectedWorktreesByRepo: { a: xcodeFailure('a'), b: xcodeFailure('b') }
    })

    const container = await renderWithRepo(repoA)
    await act(async () => {
      findButton(container, 'Retry scan')?.click()
    })
    await act(async () => {})

    expect(fetchWorktrees).toHaveBeenCalledWith('a', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
    expect(fetchWorktrees).toHaveBeenCalledWith('b', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
  })

  // Why: an unclassified failure can be repo-local; retrying peers would claim a fix we cannot prove.
  it('does not touch peers when the failure is unclassified', async () => {
    const repoA = makeRepo({ id: 'a', connectionId: null, path: '/a' })
    const repoB = makeRepo({ id: 'b', connectionId: null, path: '/b' })
    const fetchWorktrees = vi.fn(async () => true)
    const wslFailure = (repoId: string) =>
      makeDetectedResult(repoId, [], {
        authoritative: false,
        source: 'metadata-fallback',
        unavailableReason: 'wsl.exe host failure: WSL_E_DISTRO_NOT_FOUND'
      })
    useAppStore.setState({
      repos: [repoA, repoB],
      fetchWorktrees: asStoreFetch(fetchWorktrees),
      detectedWorktreesByRepo: { a: wslFailure('a'), b: wslFailure('b') }
    })

    const container = await renderWithRepo(repoA)
    await act(async () => {
      findButton(container, 'Retry scan')?.click()
    })
    await act(async () => {})

    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(fetchWorktrees).toHaveBeenCalledWith('a', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
  })

  // Why: a retry answered non-authoritatively proves nothing, so peers stay untouched and the
  // panel refreshes what this repo's scan reports now instead of quoting the previous cause.
  it('refreshes the reason without fanning out when the retry is not authoritative', async () => {
    const repoA = makeRepo({ id: 'a', connectionId: null, path: '/a' })
    const repoB = makeRepo({ id: 'b', connectionId: null, path: '/b' })
    const fetchWorktrees = vi.fn(async () => false)
    useAppStore.setState({
      repos: [repoA, repoB],
      fetchWorktrees: asStoreFetch(fetchWorktrees),
      detectedWorktreesByRepo: { a: xcodeFailure('a'), b: xcodeFailure('b') }
    })

    const container = await renderWithRepo(repoA)
    await act(async () => {
      findButton(container, 'Retry scan')?.click()
    })
    await act(async () => {})

    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenNthCalledWith(1, 'a', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
    expect(fetchWorktrees).toHaveBeenNthCalledWith(2, 'a', { executionHostId: 'local' })
    expect(fetchWorktrees).not.toHaveBeenCalledWith('b', expect.anything())
  })

  it('offers one retry-all that fans out per repo with its own host', async () => {
    const repoA = makeRepo({ id: 'a', connectionId: null, path: '/a' })
    const repoB = makeRepo({ id: 'b', connectionId: 'target-1', path: '/b' })
    const fetchWorktrees = vi.fn(async () => true)
    useAppStore.setState({
      repos: [repoA, repoB],
      fetchWorktrees: asStoreFetch(fetchWorktrees),
      detectedWorktreesByRepo: {
        a: makeDetectedResult('a', [], {
          authoritative: false,
          source: 'metadata-fallback',
          unavailableReason: 'scan failed a'
        }),
        b: makeDetectedResult('b', [], {
          authoritative: false,
          source: 'metadata-fallback',
          unavailableReason: 'scan failed b'
        })
      }
    })

    const container = await renderWithRepo(repoA)
    await act(async () => {
      findButton(container, 'Retry all failed scans (2)')?.click()
    })
    await act(async () => {})

    expect(fetchWorktrees).toHaveBeenCalledWith('a', {
      executionHostId: 'local',
      requireAuthoritative: true
    })
    expect(fetchWorktrees).toHaveBeenCalledWith('b', {
      executionHostId: 'ssh:target-1',
      requireAuthoritative: true
    })
  })
})
