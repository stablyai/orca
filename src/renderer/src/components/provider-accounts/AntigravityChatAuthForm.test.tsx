// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AntigravityChatSignInRow } from './AntigravityChatSignInRow'
import { AntigravityProviderSignInArea } from './AntigravityProviderSignInArea'
import {
  callAntigravityChatAuthConfig,
  callAntigravityChatSignIn
} from '@/runtime/runtime-antigravity-accounts-client'
import { observeAntigravityChatSignIn } from '@/runtime/antigravity-chat-sign-in-status'
import type { RuntimeRpcSubscriptionHandlers } from '@/runtime/runtime-rpc-subscribe'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const streams = vi.hoisted(() => {
  const releases: (() => void)[] = []
  return {
    handlers: new Map<string, RuntimeRpcSubscriptionHandlers>(),
    releases,
    capability: 'supported'
  }
})
const key = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? 'local' : owner.environmentId
function follow(owner: RuntimeClientTarget): void {
  streams.releases.push(observeAntigravityChatSignIn(owner))
}
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => streams.capability
}))
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatAuthConfig: vi.fn(),
  callAntigravityChatSignIn: vi.fn(async () => ({ flowId: 'new-flow' })),
  subscribeAntigravityChatSignIn: vi.fn(
    async (owner: RuntimeClientTarget, handlers: RuntimeRpcSubscriptionHandlers) => {
      streams.handlers.set(owner.kind === 'local' ? 'local' : owner.environmentId, handlers)
      handlers.onEvent({ revision: 0, auth: 'unknown', flow: null })
      return { unsubscribe: () => {} }
    }
  )
}))
afterEach(() => {
  cleanup()
  streams.releases.splice(0).forEach((release) => release())
  streams.handlers.clear()
  vi.mocked(callAntigravityChatAuthConfig).mockReset()
  vi.mocked(callAntigravityChatSignIn).mockClear()
  streams.capability = 'supported'
  vi.useRealTimers()
})

const personal = { method: 'oauth-personal' } as const
const enterprise = {
  method: 'oauth-business',
  gcpProject: 'enterprise-project',
  gcpLocation: 'us-central1'
} as const

it.each(['accounts', 'provider'] as const)(
  '%s saves the visible Enterprise choice before the first Sign in click, sharing the last-field blur save',
  async (surface) => {
    const target = { kind: 'environment', environmentId: `blur-click-${surface}` } as const
    let finish!: (value: typeof enterprise) => void
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) =>
      config === undefined
        ? Promise.resolve(personal)
        : new Promise((resolve) => {
            finish = resolve
          })
    )
    const user = userEvent.setup()
    if (surface === 'accounts') {
      render(
        <AntigravityChatSignInRow
          owner={target}
          label="Test host"
          description=""
          disabled={false}
        />
      )
    } else {
      render(
        <AntigravityProviderSignInArea
          owner={target}
          label="Test host"
          install={{
            kind: 'active',
            removable: true,
            subject: { target, runtimeId: null, agent: 'antigravity' },
            snapshot: {
              kind: 'known',
              state: {
                agent: 'antigravity',
                revision: 1,
                available: true,
                version: '1',
                installedVersion: '1',
                installedCurrent: true,
                operation: null,
                source: 'managed'
              }
            }
          }}
        />
      )
    }
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    expect(screen.queryByLabelText('Google Cloud project')).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Gemini Enterprise' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Google Cloud project'), enterprise.gcpProject)
    await act(async () => {
      streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
    })
    await user.type(screen.getByLabelText('Google Cloud location'), enterprise.gcpLocation)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, enterprise)
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
    await act(async () => {
      finish(enterprise)
    })
    await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
    expect(callAntigravityChatSignIn).toHaveBeenCalledTimes(1)
  }
)

it('keeps the visible draft and does not start sign-in after a failed automatic save', async () => {
  const target = { kind: 'environment', environmentId: 'failed-save' } as const
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) =>
    config === undefined
      ? Promise.resolve(enterprise)
      : Promise.reject(new Error('Could not save account settings'))
  )
  const user = userEvent.setup()
  render(
    <AntigravityChatSignInRow owner={target} label="Test host" description="" disabled={false} />
  )
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await user.type(screen.getByLabelText('Google Cloud project'), '-changed')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Google Cloud project')).toHaveValue('enterprise-project-changed')
  expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
})

it('does not start a departed host after its prepared save settles', async () => {
  const target = { kind: 'environment', environmentId: 'departed-host' } as const
  let finish!: (value: typeof enterprise) => void
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) =>
    config === undefined
      ? Promise.resolve(enterprise)
      : new Promise((resolve) => {
          finish = resolve
        })
  )
  const user = userEvent.setup()
  const view = render(
    <AntigravityChatSignInRow owner={target} label="Test host" description="" disabled={false} />
  )
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await user.type(screen.getByLabelText('Google Cloud project'), '-changed')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  view.unmount()
  await act(async () => {
    finish(enterprise)
  })
  expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
})

it('retains sign-in for an older host without configuration capability', async () => {
  streams.capability = 'unsupported'
  const target = { kind: 'environment', environmentId: 'old-host' } as const
  const user = userEvent.setup()
  render(
    <AntigravityChatSignInRow owner={target} label="Test host" description="" disabled={false} />
  )
  await user.click(await screen.findByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
  expect(callAntigravityChatAuthConfig).not.toHaveBeenCalled()
})

it('follows another client’s account change while mounted and allows Personal to be applied again', async () => {
  let current: typeof personal | typeof enterprise = personal
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation(
    async (_owner, config) => config ?? current
  )
  const user = userEvent.setup()
  const target = { kind: 'environment', environmentId: 'connected-client-change' } as const
  follow(target)
  render(
    <AntigravityChatSignInRow owner={target} label="Test host" description="" disabled={false} />
  )
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  await act(async () => {
    current = enterprise
    streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
  })
  await waitFor(() =>
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue('enterprise-project')
  )
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: 'Google account (personal)' }))
  await waitFor(() =>
    expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, {
      method: 'oauth-personal',
      gcpProject: 'enterprise-project',
      gcpLocation: 'us-central1'
    })
  )
})

it('refreshes the saved method after reconnecting to a restarted host with the same revision', async () => {
  const target = { kind: 'environment', environmentId: 'restarted-host' } as const
  let current:
    | typeof personal
    | { method: 'oauth-business'; gcpProject: string; gcpLocation: string } = personal
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation(
    async (_owner, config) => config ?? current
  )
  follow(target)
  render(
    <AntigravityChatSignInRow owner={target} label="Test host" description="" disabled={false} />
  )
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  vi.useFakeTimers()
  await act(async () => {
    current = {
      method: 'oauth-business',
      gcpProject: 'persisted-enterprise-project',
      gcpLocation: 'us-central1'
    }
    streams.handlers.get(key(target))?.onClose()
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  await waitFor(() =>
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue(
      'persisted-enterprise-project'
    )
  )
  expect(screen.getByRole('combobox')).toHaveTextContent('Gemini Enterprise')
})
