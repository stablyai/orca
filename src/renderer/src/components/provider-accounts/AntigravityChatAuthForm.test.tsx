// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { TooltipProvider } from '../ui/tooltip'
import { AntigravityChatSignInRow } from './AntigravityChatSignInRow'
import { AntigravityProviderSignInArea } from './AntigravityProviderSignInArea'
import {
  callAntigravityChatAuthConfig,
  callAntigravityChatSignIn
} from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { observeAntigravityChatSignIn } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeRpcSubscriptionHandlers } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import type { AntigravityChatAuthConfig } from '../../../../shared/antigravity-chat-auth-config'
import type { AntigravityChatSignInStatus } from '../../../../shared/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const streams = vi.hoisted(() => {
  const releases: (() => void)[] = []
  return {
    handlers: new Map<string, RuntimeRpcSubscriptionHandlers>(),
    releases,
    initial: new Map<string, AntigravityChatSignInStatus>(),
    capability: 'supported'
  }
})
const key = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? 'local' : owner.environmentId
function follow(owner: RuntimeClientTarget): void {
  streams.releases.push(observeAntigravityChatSignIn(owner))
}
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => streams.capability
}))
vi.mock('@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatAuthConfig: vi.fn(),
  callAntigravityChatSignIn: vi.fn(async () => ({ flowId: 'new-flow' })),
  subscribeAntigravityChatSignIn: vi.fn(
    async (owner: RuntimeClientTarget, handlers: RuntimeRpcSubscriptionHandlers) => {
      streams.handlers.set(owner.kind === 'local' ? 'local' : owner.environmentId, handlers)
      handlers.onEvent(
        streams.initial.get(key(owner)) ?? { revision: 0, auth: 'unknown', flow: null }
      )
      return { unsubscribe: () => {} }
    }
  )
}))
afterEach(async () => {
  await i18n.changeLanguage('en')
  cleanup()
  streams.releases.splice(0).forEach((release) => release())
  streams.handlers.clear()
  streams.initial.clear()
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

function renderSurface(surface: 'accounts' | 'provider', target: RuntimeClientTarget) {
  if (surface === 'accounts') {
    render(
      <TooltipProvider>
        <AntigravityChatSignInRow owner={target} label="Test host" disabled={false} />
      </TooltipProvider>
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
}

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
    renderSurface(surface, target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    expect(screen.queryByLabelText('Google Cloud project')).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Gemini Enterprise' }))
    expect(screen.getByRole('button', { name: /^Sign in/ })).toBeDisabled()
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Google Cloud project'), enterprise.gcpProject)
    await act(async () => {
      streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
    })
    await user.type(screen.getByLabelText('Location'), enterprise.gcpLocation)
    await user.click(screen.getByRole('button', { name: /^Sign in/ }))
    expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, enterprise)
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
    await act(async () => {
      finish(enterprise)
    })
    await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
    expect(callAntigravityChatSignIn).toHaveBeenCalledTimes(1)
  }
)

it.each([
  { surface: 'accounts', language: 'en', action: 'Sign in with Gemini Enterprise' },
  { surface: 'provider', language: 'en', action: 'Sign in with Gemini Enterprise' },
  { surface: 'accounts', language: 'es', action: 'Sign in with Gemini Enterprise' }
] as const)(
  '$surface keeps a failed-save draft editable and retries through Sign in ($language)',
  async ({ surface, language, action }) => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage(language)
    const target = {
      kind: 'environment',
      environmentId: `failed-save-${surface}-${language}`
    } as const
    const failure = "Orca couldn't save your Antigravity sign-in settings. Try again."
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) =>
      config === undefined
        ? Promise.resolve(enterprise)
        : Promise.reject(
            new RuntimeRpcCallError({
              id: 'save',
              ok: false,
              error: { code: 'runtime_error', message: failure }
            })
          )
    )
    const user = userEvent.setup()
    renderSurface(surface, target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    const project = screen.getAllByRole('textbox')[0]
    await user.type(project, '-changed')
    await user.click(screen.getByRole('button', { name: action }))
    await screen.findByRole('alert')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(project).toHaveValue('enterprise-project-changed')
    expect(screen.getByRole('combobox')).toBeEnabled()
    expect(screen.getByRole('button', { name: action })).toBeEnabled()
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation(
      async (_owner, config) => config ?? enterprise
    )
    await user.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
    expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, {
      ...enterprise,
      gcpProject: 'enterprise-project-changed'
    })
  }
)

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
    <AntigravityChatSignInRow owner={target} label="Test host" disabled={false} />,
    {
      wrapper: TooltipProvider
    }
  )
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await user.type(screen.getByLabelText('Google Cloud project'), '-changed')
  await user.click(screen.getByRole('button', { name: /^Sign in/ }))
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
  render(<AntigravityChatSignInRow owner={target} label="Test host" disabled={false} />, {
    wrapper: TooltipProvider
  })
  await user.click(await screen.findByRole('button', { name: /^Sign in/ }))
  await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
  expect(callAntigravityChatAuthConfig).not.toHaveBeenCalled()
})

it('commits the visible choice before sign-in while another client’s refresh is unresolved', async () => {
  const target = { kind: 'environment', environmentId: 'connected-client-change' } as const
  let refreshing = false
  let finishSave!: (value: typeof personal) => void
  let finishRead!: (value: typeof enterprise) => void
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) => {
    if (config) {
      return new Promise((resolve) => {
        finishSave = resolve
      })
    }
    return refreshing
      ? new Promise((resolve) => {
          finishRead = resolve
        })
      : Promise.resolve(personal)
  })
  const user = userEvent.setup()
  render(<AntigravityChatSignInRow owner={target} label="Test host" disabled={false} />, {
    wrapper: TooltipProvider
  })
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await act(async () => {
    refreshing = true
    streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
  })
  await user.click(screen.getByRole('button', { name: /^Sign in/ }))
  expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, personal)
  expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
  await act(async () => {
    finishSave(personal)
  })
  await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
  await act(async () => {
    finishRead(enterprise)
  })
  expect(screen.getByRole('combobox')).toHaveTextContent('Google account')
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
  render(<AntigravityChatSignInRow owner={target} label="Test host" disabled={false} />, {
    wrapper: TooltipProvider
  })
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('button', { name: /^Sign in/ })).toBeEnabled()
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

it.each(['accounts', 'provider'] as const)(
  '%s uses its single Sign in action to reread a failed load before preparing Enterprise',
  async (surface) => {
    const target = { kind: 'environment', environmentId: `load-recovery-${surface}` } as const
    vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Host unreachable'))
    const user = userEvent.setup()
    renderSurface(surface, target)
    await screen.findByRole('alert')
    await act(async () => streams.handlers.get(key(target))?.onError(new Error('Connection lost')))
    const action = screen.getByRole('button', { name: /Sign in|Retry sign-in/ })
    const info = screen.queryByRole('button', { name: 'Separate from your agy terminal account.' })
    expect(screen.getAllByRole('button').filter((button) => button !== info)).toEqual([action])
    expect(action).toBeEnabled()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(action)
    expect(action).toBeEnabled()
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
    const requests: unknown[] = []
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation(async (_owner, config) => {
      requests.push(config ?? 'Get')
      return config ?? enterprise
    })
    await user.click(action)
    await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
    expect(requests).toEqual(['Get', enterprise])
    expect(screen.getByRole('combobox')).toHaveTextContent('Gemini Enterprise')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Connection lost'))
    await act(async () =>
      streams.handlers.get(key(target))?.onEvent({ revision: 2, auth: 'unknown', flow: null })
    )
    await screen.findByRole('alert')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Google Cloud project')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Location')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sign in/ })).toBeEnabled()
  }
)

it.each(['accounts', 'provider'] as const)(
  '%s keeps an active sign-in usable when its background settings refresh fails',
  async (surface) => {
    const target = { kind: 'environment', environmentId: `active-read-failure-${surface}` } as const
    vi.mocked(callAntigravityChatAuthConfig).mockResolvedValue(personal)
    const user = userEvent.setup()
    renderSurface(surface, target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Connection lost'))
    await act(async () => {
      streams.handlers.get(key(target))?.onEvent({
        revision: 1,
        auth: 'unknown',
        flow: { phase: 'waiting', flowId: 'own-flow', url: 'https://example.com/sign-in' }
      })
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy sign-in link' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: "Browser page didn't load?" }))
    expect(screen.getByRole('textbox')).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Cancel', { flowId: 'own-flow' })
    await act(async () => {
      streams.handlers
        .get(key(target))
        ?.onEvent({ revision: 2, auth: 'unknown', flow: { phase: 'waiting', flowId: null } })
    })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sign-in is in progress in another client.'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => {
      streams.handlers.get(key(target))?.onEvent({ revision: 3, auth: 'unknown', flow: null })
    })
    expect(await screen.findByRole('button', { name: /^Sign in/ })).toBeEnabled()
  }
)

it('keeps an edited draft ahead of another client’s choice when recovering a failed refresh', async () => {
  const target = { kind: 'environment', environmentId: 'edited-load-recovery' } as const
  vi.mocked(callAntigravityChatAuthConfig).mockResolvedValue(enterprise)
  const user = userEvent.setup()
  renderSurface('accounts', target)
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await user.type(screen.getByLabelText('Google Cloud project'), '-new')
  vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Connection lost'))
  await act(async () =>
    streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
  )
  await screen.findByRole('alert')
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation(
    async (_owner, config) => config ?? personal
  )
  await user.click(screen.getByRole('button', { name: /^Sign in/ }))
  await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
  expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, {
    ...enterprise,
    gcpProject: 'enterprise-project-new'
  })
})

it('leaves recovered incomplete settings editable without starting Personal', async () => {
  const target = { kind: 'environment', environmentId: 'incomplete-load-recovery' } as const
  vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Connection lost'))
  const user = userEvent.setup()
  renderSurface('accounts', target)
  await screen.findByRole('alert')
  vi.mocked(callAntigravityChatAuthConfig).mockResolvedValue(null)
  await user.click(screen.getByRole('button', { name: /^Sign in/ }))
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('combobox')).not.toHaveTextContent('Google account')
  expect(screen.getByRole('button', { name: /^Sign in/ })).toBeDisabled()
  expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
})

it.each(['success', 'failure'] as const)(
  'keeps the editable failed-save draft when an overlapping Get settles with %s after Apply',
  async (outcome) => {
    const target = { kind: 'environment', environmentId: `late-read-${outcome}` } as const
    let finishSave!: (cause: Error) => void
    const save = new Promise<AntigravityChatAuthConfig>((_resolve, reject) => {
      finishSave = reject
    })
    let finishRead!: (value: AntigravityChatAuthConfig) => void
    let rejectRead!: (cause: Error) => void
    const read = new Promise<AntigravityChatAuthConfig>((resolve, reject) => {
      finishRead = resolve
      rejectRead = reject
    })
    let refreshing = false
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) =>
      config ? save : refreshing ? read : Promise.resolve(enterprise)
    )
    const user = userEvent.setup()
    renderSurface('accounts', target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    await user.type(screen.getByLabelText('Google Cloud project'), '-new')
    await user.click(screen.getByRole('button', { name: /^Sign in/ }))
    refreshing = true
    await act(async () => {
      streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
    })
    await act(async () => {
      finishSave(
        new RuntimeRpcCallError({
          id: 'save',
          ok: false,
          error: {
            code: 'runtime_error',
            message: 'Write failed'
          }
        })
      )
    })
    await act(async () => {
      if (outcome === 'success') {
        finishRead(personal)
      } else {
        rejectRead(new Error('Host unreachable'))
      }
    })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^Sign in/ })).toBeEnabled()
    expect(screen.getByRole('combobox')).toBeEnabled()
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue('enterprise-project-new')
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
  }
)
