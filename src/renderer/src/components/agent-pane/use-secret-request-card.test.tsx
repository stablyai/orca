// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretRequestedEvent } from '../../../../shared/secret-request-contract'
import {
  applySecretRequested,
  readSecretRequests,
  resetSecretRequestStoreForTests,
  useSecretRequests
} from '@/lib/secret-requests/secret-request-store'
import { SecretRequestCard } from './SecretRequestCard'
import {
  resetSecretRequestCardCachesForTests,
  SECRET_REQUEST_TOUCH_INTERVAL_MS,
  useSecretRequestCard
} from './use-secret-request-card'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))

const NOW = 1_700_000_000_000
const put = vi.fn()
const refreshEnv = vi.fn()
const effective = vi.fn()
const workspaceSharing = vi.fn()

function event(patch: Partial<SecretRequestedEvent> = {}): SecretRequestedEvent {
  return {
    type: 'secrets.requested',
    requestId: 'sr_aaaaaaaa',
    name: 'NPM_TOKEN',
    reason: 'See <a href="https://evil.example">here</a>',
    scope: 'repo',
    agent: 'claude',
    worktreeId: null,
    terminalHandle: 'h1',
    requestedAt: NOW,
    expiresAt: NOW + 15 * 60_000,
    ...patch
  }
}

function Harness(): React.JSX.Element | null {
  const entry = useSecretRequests()[0]
  return entry ? <Card entry={entry} /> : null
}

function Card({ entry }: { entry: ReturnType<typeof readSecretRequests>[number] }) {
  const { model, actions } = useSecretRequestCard({
    entry,
    more: 0,
    worktreeId: null,
    ptyId: 'p',
    onAskingPane: true
  })
  return <SecretRequestCard model={model} actions={actions} />
}

function valueInput(): HTMLInputElement {
  return screen.getByLabelText('Value for NPM_TOKEN')
}

describe('S4-b secret request card', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    put.mockResolvedValue({ ok: true, value: {} })
    refreshEnv.mockResolvedValue({ ok: true, value: true })
    effective.mockResolvedValue({ ok: false, error: 'unavailable' })
    workspaceSharing.mockResolvedValue({
      ok: true,
      value: { shared: false, ownerName: null, isOwner: true }
    })
    rpc.mockImplementation(async (_target, method: string) =>
      method === 'secrets.touchRequest'
        ? { expiresAt: Date.now() + 15 * 60_000 }
        : { outcome: 'provided' }
    )
    Object.assign(window, {
      api: { cloudSecrets: { put, refreshEnv, effective, workspaceSharing } }
    })
    applySecretRequested('env-1', event())
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
    resetSecretRequestStoreForTests()
    resetSecretRequestCardCachesForTests()
  })

  it('shows the reason as plain text and never preselects the agent’s Repository hint', () => {
    render(<Harness />)
    expect(document.querySelector('a')).toBeNull()
    expect(screen.getByText(/See <a href=/)).toBeTruthy()
    // Repository isn't writable here, so only the Personal chip shows.
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText(/Commands in this workspace can read it as \$NPM_TOKEN/)).toBeTruthy()
  })

  it('in a shared workspace never offers Personal (SEC-5): says who can add it instead', async () => {
    workspaceSharing.mockResolvedValue({
      ok: true,
      value: { shared: true, ownerName: 'Ada', isOwner: false }
    })
    render(<Harness />)
    await act(async () => {})
    expect(workspaceSharing).toHaveBeenCalledWith({ runtimeEnvironmentId: 'env-1' })
    expect(
      screen.getByText('This workspace is shared, so it doesn’t get personal secrets.')
    ).toBeTruthy()
    expect(screen.queryByLabelText('Value for NPM_TOKEN')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add secret' }).getAttribute('aria-disabled')).toBe(
      'true'
    )
    expect(put).not.toHaveBeenCalled()
  })

  it('fails closed when the workspace sharing can’t be read', async () => {
    workspaceSharing.mockRejectedValue(new Error('down'))
    render(<Harness />)
    await act(async () => {})
    expect(screen.queryByLabelText('Value for NPM_TOKEN')).toBeNull()
  })

  it('saves through Cloud secrets, then tells orcad the outcome without the value', async () => {
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'npm_secret_1' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    })
    expect(put).toHaveBeenCalledWith({
      target: { scope: 'personal' },
      name: 'NPM_TOKEN',
      value: 'npm_secret_1'
    })
    const resolve = rpc.mock.calls.find(([, method]) => method === 'secrets.resolveRequest')
    expect(resolve?.[2]).toEqual({ requestId: 'sr_aaaaaaaa', outcome: 'provided' })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('npm_secret_1')
    expect(screen.getByText('NPM_TOKEN added to your personal secrets.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Restart Claude/ })).toBeTruthy()
  })

  it('says the agent stopped waiting when the request expired mid-save', async () => {
    rpc.mockImplementation(async (_target, method: string) =>
      method === 'secrets.resolveRequest' ? { outcome: 'expired' } : { expiresAt: NOW }
    )
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'v' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    })
    expect(screen.getByText(/Claude stopped waiting, so tell it the secret is ready/)).toBeTruthy()
  })

  it('keeps the value and offers Try again when Orca Cloud is unreachable', async () => {
    put.mockResolvedValue({ ok: false, error: 'unavailable' })
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'v' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    })
    expect(screen.getByText('Couldn’t reach Orca Cloud.')).toBeTruthy()
    expect(valueInput().value).toBe('v')
    expect(rpc.mock.calls.some(([, method]) => method === 'secrets.resolveRequest')).toBe(false)
  })

  it('touches the request at most once a minute while a value is typed', async () => {
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'v' } })
    await act(async () => {
      vi.advanceTimersByTime(0)
    })
    fireEvent.focus(valueInput())
    fireEvent.blur(valueInput())
    fireEvent.focus(valueInput())
    await act(async () => {
      vi.advanceTimersByTime(SECRET_REQUEST_TOUCH_INTERVAL_MS * 2 + 1_000)
    })
    const touches = rpc.mock.calls.filter(([, method]) => method === 'secrets.touchRequest')
    expect(touches).toHaveLength(3)
  })

  it('expires on its own clock and clears what was typed', async () => {
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'typed' } })
    // Fails the touch so the expiry stays put.
    rpc.mockRejectedValue(new Error('offline'))
    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000 + 1)
    })
    expect(screen.getByText('This request expired.')).toBeTruthy()
    expect(screen.queryByLabelText('Value for NPM_TOKEN')).toBeNull()
  })

  it('never declines while a save is in flight', async () => {
    let finish: (value: unknown) => void = () => {}
    put.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'v' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    })
    await act(async () => {
      fireEvent.keyDown(valueInput(), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    })
    expect(rpc.mock.calls.some(([, , params]) => params?.outcome === 'declined')).toBe(false)
    await act(async () => finish({ ok: true, value: {} }))
    expect(screen.getByText('NPM_TOKEN added to your personal secrets.')).toBeTruthy()
  })

  it('says the agent wasn’t told when orcad doesn’t answer the resolve', async () => {
    rpc.mockImplementation(async (_target, method: string) => {
      if (method === 'secrets.resolveRequest') {
        throw new Error('timeout')
      }
      return { expiresAt: NOW }
    })
    render(<Harness />)
    fireEvent.change(valueInput(), { target: { value: 'v' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    })
    expect(screen.getByText(/stopped waiting, so tell it the secret is ready/)).toBeTruthy()
  })

  it('declines on Escape', async () => {
    render(<Harness />)
    await act(async () => {
      fireEvent.keyDown(valueInput(), { key: 'Escape' })
    })
    expect(readSecretRequests()).toEqual([])
    const resolve = rpc.mock.calls.find(([, method]) => method === 'secrets.resolveRequest')
    expect(resolve?.[2]).toEqual({ requestId: 'sr_aaaaaaaa', outcome: 'declined' })
  })
})
