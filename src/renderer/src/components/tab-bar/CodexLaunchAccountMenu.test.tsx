// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexLaunchAccountMenu } from './CodexLaunchAccountMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { accountSnapshot, fetchAccountsMock, ownerTarget, supportsCapabilityMock } = vi.hoisted(
  () => ({
    accountSnapshot: {
      codex: {
        accounts: [
          {
            id: 'account-uuid-a',
            email: 'owner@example.com',
            workspaceLabel: 'Acme workspace',
            managedHomeRuntime: 'host' as const,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      claude: {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      rateLimits: null
    },
    fetchAccountsMock: vi.fn(),
    supportsCapabilityMock: vi.fn(),
    ownerTarget: {
      current: { kind: 'local' } as
        | { kind: 'local' }
        | { kind: 'runtime'; environmentId: string }
        | { kind: 'ssh'; connectionId: string }
        | undefined
    }
  })
)

vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ownerTarget.current
}))

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: fetchAccountsMock
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: supportsCapabilityMock
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ worktreesByRepo: {}, repos: [] })
}))

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalAgentPreflightContext: () => undefined
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span>codex-icon</span>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...props
  }: React.ComponentProps<'button'> & { onSelect?: () => void }) => (
    <button {...props} disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text)
  )
  if (!match) {
    throw new Error(`Missing button containing: ${text}`)
  }
  return match
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fetchAccountsMock.mockReset()
  supportsCapabilityMock.mockReset()
  supportsCapabilityMock.mockResolvedValue(true)
  ownerTarget.current = { kind: 'local' }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CodexLaunchAccountMenu', () => {
  it('keeps current-default launch available while account discovery loads', async () => {
    const request = deferred<typeof accountSnapshot>()
    fetchAccountsMock.mockReturnValue(request.promise)
    const onLaunch = vi.fn()

    await act(async () => {
      root.render(
        <CodexLaunchAccountMenu worktreeId="worktree-1" shortcut="⌘⌥T" onLaunch={onLaunch} />
      )
    })

    expect(container.querySelector('[aria-label="Launch Codex with an account"]')).not.toBeNull()
    expect(container.textContent).toContain('Loading Codex accounts…')
    await act(async () => buttonWithText(container, 'Current default').click())
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith()

    await act(async () => request.resolve(accountSnapshot))
  })

  it('shows a friendly label and launches by the canonical managed-account UUID', async () => {
    fetchAccountsMock.mockResolvedValue(accountSnapshot)
    const onLaunch = vi.fn()

    await act(async () => {
      root.render(<CodexLaunchAccountMenu worktreeId="worktree-1" onLaunch={onLaunch} />)
    })

    expect(container.textContent).toContain('Acme workspace')
    expect(container.textContent).toContain('account-uuid-a')
    await act(async () => buttonWithText(container, 'Acme workspace').click())
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith({
      provider: 'codex',
      accountId: 'account-uuid-a',
      runtime: 'host'
    })
  })

  it('surfaces load failure and retains a retryable current-default fallback', async () => {
    fetchAccountsMock.mockRejectedValueOnce(new Error('account service unavailable'))
    fetchAccountsMock.mockResolvedValueOnce(accountSnapshot)
    const onLaunch = vi.fn()

    await act(async () => {
      root.render(<CodexLaunchAccountMenu worktreeId="worktree-1" onLaunch={onLaunch} />)
    })

    expect(container.textContent).toContain('account service unavailable')
    await act(async () => buttonWithText(container, 'Retry').click())
    expect(fetchAccountsMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Acme workspace')
  })

  it('does not fetch account data for SSH and keeps the legacy default launch available', async () => {
    ownerTarget.current = { kind: 'ssh', connectionId: 'ssh-1' }
    const onLaunch = vi.fn()

    await act(async () => {
      root.render(<CodexLaunchAccountMenu worktreeId="worktree-1" onLaunch={onLaunch} />)
    })

    expect(container.textContent).toContain('Account selection is unavailable for SSH workspaces.')
    expect(fetchAccountsMock).not.toHaveBeenCalled()
    await act(async () => buttonWithText(container, 'Current default').click())
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith()
  })

  it('limits an older paired runtime to current default before fetching accounts', async () => {
    ownerTarget.current = { kind: 'runtime', environmentId: 'runtime-old' }
    supportsCapabilityMock.mockResolvedValue(false)
    const onLaunch = vi.fn()

    await act(async () => {
      root.render(<CodexLaunchAccountMenu worktreeId="worktree-1" onLaunch={onLaunch} />)
    })

    expect(supportsCapabilityMock).toHaveBeenCalledWith(
      'runtime-old',
      'agent-session.account-ref.v1'
    )
    expect(fetchAccountsMock).not.toHaveBeenCalled()
    expect(container.textContent).toContain('This runtime only supports Current default.')
    await act(async () => buttonWithText(container, 'Current default').click())
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith()
  })
})
