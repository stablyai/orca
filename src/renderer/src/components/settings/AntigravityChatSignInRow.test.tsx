// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AntigravityChatAuth,
  AntigravityChatSignInState
} from '../../../../shared/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callAntigravityChatSignIn } from '@/runtime/runtime-antigravity-accounts-client'
import type * as ManagedRuntimeInstallModule from '@/runtime/managed-runtime-install-status'
import { AgentChatRuntimeArea } from './AgentChatChoiceControls'
import { ManagedRuntimeInstallRow } from '../managed-runtime/ManagedRuntimeInstallRow'
import { antigravityChatSignInRunning } from '@/runtime/antigravity-chat-sign-in-status'
import {
  useManagedRuntimeInstall,
  type ManagedRuntimeInstallObservation
} from '@/runtime/use-managed-runtime-install'
import {
  installManagedRuntime,
  removeManagedRuntime
} from '@/runtime/managed-runtime-install-status'
import { getHostRuntimeLabel, getRuntimeSentenceLabel } from './accounts-pane-runtime'
import { AntigravityChatSignInRow, useAntigravityChatSignIn } from './AntigravityChatSignInRow'
import {
  AntigravityProviderSignInArea,
  antigravityProviderSignInShown
} from './AntigravityProviderSignInArea'
import { TooltipProvider } from '../ui/tooltip'

const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'
type FakeHost = {
  revision: number
  auth: AntigravityChatAuth
  flow: AntigravityChatSignInState | null
  streams: Set<(status: unknown) => void>
}
// Each host's own sign-in status, pushed to its subscribers by revision as the host does.
const fake = vi.hoisted(() => {
  const hosts = new Map<string, FakeHost>()
  const hostOf = (owner: RuntimeClientTarget): FakeHost => {
    const key = owner.kind === 'local' ? '' : owner.environmentId
    let host = hosts.get(key)
    if (!host) {
      host = { revision: 0, auth: 'unknown', flow: null, streams: new Set() }
      hosts.set(key, host)
    }
    return host
  }
  const status = (host: FakeHost) => ({
    revision: host.revision,
    auth: host.auth,
    flow: host.flow
  })
  const publish = (
    owner: RuntimeClientTarget,
    flow: AntigravityChatSignInState | null,
    auth: AntigravityChatAuth = 'unknown'
  ) => {
    const host = hostOf(owner)
    Object.assign(host, { revision: host.revision + 1, flow, auth })
    host.streams.forEach((emit) => emit(status(host)))
  }
  const api: {
    hostOf: typeof hostOf
    status: typeof status
    publish: typeof publish
    start: Promise<{ flowId: string }> | null
  } = { hostOf, status, publish, start: null }
  return api
})
const { publish } = fake
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatSignIn: vi.fn(async (owner: RuntimeClientTarget, action: string) => {
    if (action === 'Start') {
      if (fake.start) {
        return fake.start
      }
      fake.publish(owner, { flowId: 'f', phase: 'starting' })
      return { flowId: 'f' }
    }
    return undefined
  }),
  subscribeAntigravityChatSignIn: vi.fn(
    async (owner: RuntimeClientTarget, handlers: { onEvent: (status: unknown) => void }) => {
      const host = fake.hostOf(owner)
      host.streams.add(handlers.onEvent)
      handlers.onEvent(fake.status(host))
      return { unsubscribe: () => host.streams.delete(handlers.onEvent) }
    }
  )
}))
const install = vi.hoisted((): { current: ManagedRuntimeInstallObservation } => ({
  current: { kind: 'pending' }
}))
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: vi.fn(() => install.current)
}))
vi.mock('@/runtime/managed-runtime-install-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeInstallModule>()),
  installManagedRuntime: vi.fn(async () => {}),
  removeManagedRuntime: vi.fn(async () => {})
}))
afterEach(() => cleanup())

async function showRow(owner: RuntimeClientTarget) {
  const view = render(
    <TooltipProvider>
      <AntigravityChatSignInRow
        owner={owner}
        label="this computer"
        description=""
        disabled={false}
      />
    </TooltipProvider>
  )
  await act(async () => undefined)
  return view
}

it('opens the link once across status answers and shows signed in', async () => {
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const owner = { kind: 'local' } as const
  publish(owner, null, 'signedOut')
  const view = await showRow(owner)
  await screen.findByText('Not signed in on this computer.')
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await act(async () => publish(owner, { flowId: 'f', phase: 'waiting', url }))
  await screen.findByText('Finish signing in in your browser.')
  await act(async () => publish(owner, { flowId: 'f', phase: 'waiting', url }))
  await act(async () => publish(owner, { flowId: 'f', phase: 'verifying' }))
  await screen.findByText('Finishing sign-in…')
  await act(async () => publish(owner, { flowId: 'f', phase: 'signedIn' }, 'signedIn'))
  await screen.findByText('Signed in on this computer.')
  expect(screen.getByRole('button', { name: 'Change account' })).toBeTruthy()
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
  view.unmount()
})

it('opens nothing for a Start the host answers after the row unmounts', async () => {
  const start = Promise.withResolvers<{ flowId: string }>()
  fake.start = start.promise
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const owner = { kind: 'environment', environmentId: 'unmounted' } as const
  const view = await showRow(owner)
  await userEvent.click(view.getByRole('button', { name: 'Sign in' }))
  view.unmount()
  await act(async () => {
    start.resolve({ flowId: 'late' })
    publish(owner, { flowId: 'late', phase: 'waiting', url })
  })
  expect(openUrl).not.toHaveBeenCalled()
  fake.start = null
})

it("shows another client's sign-in without letting this one act on it", async () => {
  const owner = { kind: 'environment', environmentId: 'idle' } as const
  publish(owner, { flowId: 'done', phase: 'cancelled' })
  await showRow(owner)
  await screen.findByText('Sign-in cancelled.')
  // Authoritative host auth replaces settled flow outcomes.
  await act(async () => publish(owner, { flowId: 'done', phase: 'cancelled' }, 'signedOut'))
  await screen.findByText('Not signed in on this computer.')
  await act(async () => publish(owner, { flowId: null, phase: 'waiting' }))
  await screen.findByText('Sign-in is in progress in another client.')
  expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('sends the address pasted from a browser on another computer to the host', async () => {
  const owner = { kind: 'environment', environmentId: 'paste' } as const
  await showRow(owner)
  await act(async () => publish(owner, { flowId: 'remote', phase: 'waiting', url }))
  const continueButton = await screen.findByRole('button', { name: 'Continue' })
  const pasted = 'http://127.0.0.1:51234/?state=s&code=c'
  await userEvent.type(screen.getByRole('textbox'), pasted)
  await userEvent.click(continueButton)
  expect(callAntigravityChatSignIn).toHaveBeenCalledWith(owner, 'Complete', {
    flowId: 'remote',
    callbackUrl: pasted
  })
})

// A host learns its sign-in only when a chat starts, so after launch it has no answer to show.
it("names the account and why it's needed before the host knows its sign-in", async () => {
  const owner = { kind: 'environment', environmentId: 'provider-unanswered' } as const
  render(
    <AntigravityProviderSignInArea
      owner={owner}
      label="this computer"
      install={{
        kind: 'active',
        subject: { target: owner, runtimeId: null, agent: 'antigravity' },
        removable: true,
        snapshot: {
          kind: 'known',
          state: {
            agent: 'antigravity',
            revision: 1,
            available: true,
            version: '1.0.0',
            installedVersion: '1.0.0',
            installedCurrent: true,
            source: 'managed',
            operation: null
          }
        }
      }}
    />
  )
  await act(async () => undefined)
  expect(screen.getByText('Account')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(
    'Chats need an Antigravity sign-in, separate from your agy terminal account.'
  )
  expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false)
  await act(async () => publish(owner, null, 'signedOut'))
  expect(screen.getByRole('status').textContent).toMatch(/^Not signed in\./)
})

// Setup composition from the removed provider page; the shared controls own all commands and refusals.
function PreviousProviderSetup() {
  const runtime = useManagedRuntimeInstall({ kind: 'local' }, 'antigravity', true)
  const signIn = useAntigravityChatSignIn(runtime.kind === 'active' ? { kind: 'local' } : null)
  if (runtime.kind !== 'active') {
    return null
  }
  return (
    <>
      <ManagedRuntimeInstallRow
        observation={runtime}
        agentLabel="Antigravity"
        signInRunning={antigravityChatSignInRunning(signIn.flow)}
      >
        {(line, actions) => (
          <>
            {line}
            {actions}
          </>
        )}
      </ManagedRuntimeInstallRow>
      {antigravityProviderSignInShown(runtime) ? (
        <AntigravityProviderSignInArea
          owner={{ kind: 'local' }}
          label={getRuntimeSentenceLabel({ runtime: 'host', label: getHostRuntimeLabel() })}
          install={runtime}
        />
      ) : null}
    </>
  )
}

it('preserves moved setup owner, actions and failure states through collapse and a late sign-in reply', async () => {
  const owner = { kind: 'local' } as const
  const subject = { target: owner, runtimeId: null, agent: 'antigravity' }
  for (const previous of [true, false]) {
    vi.clearAllMocks()
    publish(owner, null, 'signedOut')
    const openUrl = vi.fn(async () => undefined)
    Object.assign(window, { api: { shell: { openUrl } } })
    install.current = { kind: 'active', subject, removable: true, snapshot: { kind: 'readFailed' } }
    const element = (expanded = true) => (
      <TooltipProvider>
        {expanded ? (
          previous ? (
            <PreviousProviderSetup />
          ) : (
            <AgentChatRuntimeArea agent="antigravity" label="Antigravity" />
          )
        ) : null}
      </TooltipProvider>
    )
    const view = render(element())
    await act(async () => undefined)
    expect(useManagedRuntimeInstall).toHaveBeenCalledWith(owner, 'antigravity', true)
    expect(screen.getByText('Could not check Antigravity on this host. Retrying.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false)
    const state = {
      agent: 'antigravity',
      revision: 1,
      available: true,
      version: '1',
      installedVersion: null,
      installedCurrent: false,
      operation: null,
      source: null
    }
    install.current = {
      kind: 'active',
      subject,
      removable: true,
      snapshot: { kind: 'known', state }
    }
    view.rerender(element())
    expect(screen.queryByText('Account')).toBeNull()
    vi.mocked(installManagedRuntime).mockRejectedValueOnce(
      new Error('Installation refused. Try again.')
    )
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(installManagedRuntime).toHaveBeenCalledExactlyOnceWith(subject)
    await screen.findByText('Installation refused. Try again.')
    install.current = {
      kind: 'active',
      subject,
      removable: true,
      snapshot: {
        kind: 'known',
        state: {
          ...state,
          source: 'managed',
          installedVersion: '1',
          installedCurrent: true,
          canRemove: true
        }
      }
    }
    view.rerender(element())
    expect(screen.getByText('Account')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Antigravity' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove downloaded runtime' }))
    vi.mocked(removeManagedRuntime).mockRejectedValueOnce(new Error('Removal refused. Try again.'))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeManagedRuntime).toHaveBeenCalledExactlyOnceWith(subject)
    await screen.findByText('Removal refused. Try again.')
    vi.mocked(callAntigravityChatSignIn).mockRejectedValueOnce(
      new Error('Sign-in refused. Try again.')
    )
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(callAntigravityChatSignIn).toHaveBeenCalledWith(owner, 'Start')
    await screen.findByText('Sign-in refused. Try again.')
    const late = Promise.withResolvers<{ flowId: string }>()
    fake.start = late.promise
    await userEvent.click(screen.getByRole('button', { name: 'Retry sign-in' }))
    view.rerender(element(false))
    await act(async () => {
      late.resolve({ flowId: 'late-moved' })
      publish(owner, { flowId: 'late-moved', phase: 'waiting', url })
    })
    expect(openUrl).not.toHaveBeenCalled()
    fake.start = null
    view.rerender(element())
    await screen.findByText('Finish signing in in your browser.')
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Antigravity' }))
    expect(
      screen
        .getByRole('menuitem', { name: 'Remove downloaded runtime' })
        .getAttribute('aria-disabled')
    ).toBe('true')
    await userEvent.keyboard('{Escape}')
    await userEvent.type(screen.getByRole('textbox'), 'invalid callback')
    vi.mocked(callAntigravityChatSignIn).mockRejectedValueOnce(
      new Error('Paste the complete browser address.')
    )
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(callAntigravityChatSignIn).toHaveBeenCalledWith(owner, 'Complete', {
      flowId: 'late-moved',
      callbackUrl: 'invalid callback'
    })
    await screen.findByText('Paste the complete browser address.')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(callAntigravityChatSignIn).toHaveBeenCalledWith(owner, 'Cancel', {
      flowId: 'late-moved'
    })
    cleanup()
  }
})
