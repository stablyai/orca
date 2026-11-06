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
} from '@/runtime/runtime-antigravity-accounts-client'
import { observeAntigravityChatSignIn } from '@/runtime/antigravity-chat-sign-in-status'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeRpcSubscriptionHandlers } from '@/runtime/runtime-rpc-subscribe'
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
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => streams.capability
}))
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
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
        <AntigravityChatSignInRow
          owner={target}
          label="Test host"
          description=""
          disabled={false}
        />
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

it.each([
  { surface: 'accounts', language: 'en', action: 'Sign in' },
  { surface: 'provider', language: 'en', action: 'Sign in' },
  { surface: 'accounts', language: 'es', action: 'Iniciar sesión' }
] as const)(
  '$surface retains the draft and restart instruction after an unconfirmed save ($language)',
  async ({ surface, language, action }) => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage(language)
    const target = {
      kind: 'environment',
      environmentId: `failed-save-${surface}-${language}`
    } as const
    const failure =
      "Orca couldn't finish saving your Antigravity sign-in settings. Restart Orca on this host, then try again."
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation((_owner, config) =>
      config === undefined
        ? Promise.resolve(enterprise)
        : Promise.reject(
            new RuntimeRpcCallError({
              id: 'save',
              ok: false,
              error: { code: 'antigravity_account_settings_unconfirmed', message: failure }
            })
          )
    )
    const user = userEvent.setup()
    renderSurface(surface, target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    const project = screen.getAllByRole('textbox')[0]
    await user.type(project, '-changed')
    await user.click(screen.getByRole('button', { name: action }))
    expect(await screen.findByRole('alert')).toHaveTextContent(failure)
    expect(screen.getAllByText(failure)).toHaveLength(1)
    expect(project).toHaveValue('enterprise-project-changed')
    expect(
      screen.queryByRole('button', { name: /Retry|Sign in|Reintentar|Iniciar sesi/ })
    ).not.toBeInTheDocument()
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
  }
)

it.each([
  { surface: 'accounts', language: 'en' },
  { surface: 'provider', language: 'en' },
  { surface: 'accounts', language: 'es' }
] as const)(
  '$surface presents a direct failed sign-in and rejected settings read once ($language)',
  async ({ surface, language }) => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage(language)
    const target = {
      kind: 'environment',
      environmentId: `failed-read-${surface}-${language}`
    } as const
    const failure =
      "Orca couldn't finish saving your Antigravity sign-in settings. Restart Orca on this host, then try again."
    streams.initial.set(key(target), {
      revision: 1,
      auth: 'unknown',
      flow: { phase: 'failed', flowId: null, error: 'Antigravity sign-in failed. Try again.' }
    })
    let rejectRead!: (cause: Error) => void
    const read = new Promise<AntigravityChatAuthConfig | null>((_resolve, reject) => {
      rejectRead = reject
    })
    vi.mocked(callAntigravityChatAuthConfig).mockReturnValue(read)
    renderSurface(surface, target)
    await waitFor(() => expect(callAntigravityChatAuthConfig).toHaveBeenCalledWith(target))
    await act(async () => {
      rejectRead(
        new RuntimeRpcCallError({
          id: 'read',
          ok: false,
          error: { code: 'antigravity_account_settings_unconfirmed', message: failure }
        })
      )
    })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent(failure)
    expect(screen.getAllByText(failure)).toHaveLength(1)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /Retry|Sign in|Reintentar|Iniciar sesi/ })
    ).not.toBeInTheDocument()
    expect(callAntigravityChatSignIn).not.toHaveBeenCalled()
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
  render(
    <AntigravityChatSignInRow owner={target} label="Test host" description="" disabled={false} />
  )
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await act(async () => {
    refreshing = true
    streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
  })
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
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

it.each(['accounts', 'provider'] as const)(
  '%s preserves another client’s active and settled sign-in status',
  async (surface) => {
    const target = { kind: 'environment', environmentId: `other-client-${surface}` } as const
    streams.initial.set(key(target), {
      revision: 0,
      auth: 'unknown',
      flow: { phase: 'waiting', flowId: null }
    })
    vi.mocked(callAntigravityChatAuthConfig).mockResolvedValue(personal)
    renderSurface(surface, target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sign-in is in progress in another client.'
    )
    await act(async () => {
      streams.handlers
        .get(key(target))
        ?.onEvent({ revision: 1, auth: 'unknown', flow: { phase: 'expired', flowId: null } })
    })
    expect(screen.getByRole('status')).toHaveTextContent('Sign-in timed out. Try again.')
  }
)

it.each(['accounts', 'provider'] as const)(
  '%s preserves signed-in host context and explains a changed method',
  async (surface) => {
    const target = { kind: 'environment', environmentId: `signed-in-${surface}` } as const
    streams.initial.set(key(target), { revision: 0, auth: 'signedIn', flow: null })
    let current: AntigravityChatAuthConfig = personal
    vi.mocked(callAntigravityChatAuthConfig).mockImplementation(async (_owner, config) => {
      if (config) {
        current = config
      }
      return current
    })
    const user = userEvent.setup()
    renderSurface(surface, target)
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('Signed in on Test host.')
    expect(screen.getByRole('button', { name: 'Change account' })).toBeEnabled()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Gemini Enterprise' }))
    expect(screen.getByRole('status')).toHaveTextContent('Sign in again to use Gemini Enterprise.')
    await user.type(screen.getByLabelText('Google Cloud project'), enterprise.gcpProject)
    await user.type(screen.getByLabelText('Google Cloud location'), enterprise.gcpLocation)
    await user.tab()
    await act(async () => {
      streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
    })
    expect(screen.getByRole('status')).toHaveTextContent('Sign in again to use Gemini Enterprise.')
  }
)

it.each(['accounts', 'provider'] as const)(
  '%s retries initial and refreshed load failures to usable settings',
  async (surface) => {
    const target = { kind: 'environment', environmentId: `load-recovery-${surface}` } as const
    vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Host unreachable'))
    const user = userEvent.setup()
    renderSurface(surface, target)
    for (const revision of [1, 2]) {
      const message = await screen.findByRole('alert')
      const retry = screen.getByRole('button', { name: 'Retry' })
      expect(message.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(screen.getAllByRole('button')).toEqual([retry])
      expect(screen.getByRole('combobox')).toBeDisabled()
      vi.mocked(callAntigravityChatAuthConfig).mockResolvedValue(personal)
      await user.click(retry)
      await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
      if (revision === 1) {
        vi.mocked(callAntigravityChatAuthConfig).mockRejectedValue(new Error('Connection lost'))
        await act(async () => {
          streams.handlers.get(key(target))?.onEvent({ revision, auth: 'unknown', flow: null })
        })
      }
    }
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
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled()
  }
)

it('keeps an ordinary failed save draft retryable through the existing sign-in action', async () => {
  const target = { kind: 'environment', environmentId: 'rolled-back-save' } as const
  let fail = true
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation(async (_owner, config) => {
    if (config && fail) {
      throw new Error('Disk full')
    }
    return config ?? enterprise
  })
  const user = userEvent.setup()
  renderSurface('accounts', target)
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await user.type(screen.getByLabelText('Google Cloud project'), '-new')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Google Cloud project')).toHaveValue('enterprise-project-new')
  fail = false
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(callAntigravityChatSignIn).toHaveBeenCalledWith(target, 'Start'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
