// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { AntigravityChatSignInState } from '../../../../shared/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callAntigravityChatSignIn } from '@/runtime/runtime-antigravity-accounts-client'
import { AntigravityChatSignInRow } from './AntigravityChatSignInRow'
import { TooltipProvider } from '../ui/tooltip'

const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'
type FakeHost = {
  revision: number
  saved: boolean
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
      host = { revision: 0, saved: false, flow: null, streams: new Set() }
      hosts.set(key, host)
    }
    return host
  }
  const status = (host: FakeHost) => ({
    revision: host.revision,
    saved: host.saved,
    flow: host.flow
  })
  const publish = (owner: RuntimeClientTarget, flow: AntigravityChatSignInState, saved = false) => {
    const host = hostOf(owner)
    Object.assign(host, { revision: host.revision + 1, flow, saved })
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
afterEach(() => cleanup())

async function showRow(owner: RuntimeClientTarget) {
  const view = render(
    <TooltipProvider>
      <AntigravityChatSignInRow owner={owner} label="" description="" disabled={false} />
    </TooltipProvider>
  )
  // Sign in stays disabled until the host's snapshot lands.
  await act(async () => undefined)
  return view
}

it('opens the link once across status answers and shows signed in', async () => {
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  const owner = { kind: 'local' } as const
  const view = await showRow(owner)
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  await act(async () => publish(owner, { flowId: 'f', phase: 'waiting', url }))
  await screen.findByText('Finish signing in in your browser.')
  await act(async () => publish(owner, { flowId: 'f', phase: 'waiting', url }))
  await act(async () => publish(owner, { flowId: 'f', phase: 'signedIn' }, true))
  await screen.findByText('Signed in.')
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

it('an idle row shows a sign-in another device starts, and can cancel it', async () => {
  const owner = { kind: 'environment', environmentId: 'idle' } as const
  publish(owner, { flowId: 'done', phase: 'cancelled' })
  const openUrl = vi.fn(async () => undefined)
  Object.assign(window, { api: { shell: { openUrl } } })
  await showRow(owner)
  await screen.findByText('Sign-in cancelled.')
  await act(async () => publish(owner, { flowId: 'other', phase: 'waiting', url }))
  await screen.findByText('Finish signing in in your browser.')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(callAntigravityChatSignIn).toHaveBeenCalledWith(owner, 'Cancel', { flowId: 'other' })
  expect(openUrl).not.toHaveBeenCalled()
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
