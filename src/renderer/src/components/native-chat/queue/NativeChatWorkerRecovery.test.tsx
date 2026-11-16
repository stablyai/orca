// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatWorkerFailureStatus } from './NativeChatWorkerFailureStatus'
import { NativeChatQueueHeader } from './NativeChatQueueHeader'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentSessionHeldDelivery } from '../../../../../shared/agent-session/agent-session-held-delivery'
import { observedProviderAccounts } from '@/runtime/provider-accounts/observations/observed-provider-accounts'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import * as providerAccountsClient from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps owner Resume available across sign-in without automatically releasing saved input', async () => {
  vi.spyOn(providerAccountsClient, 'watchProviderAccounts').mockReturnValue({ close: () => {} })
  const target = { kind: 'environment' as const, environmentId: 'recovery' }
  const snapshot: ProviderAccountsSnapshot['claude'] = {
    accounts: [
      {
        id: 'account',
        email: 'owner@example.com',
        authMethod: 'subscription-oauth',
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1,
        home: '/account'
      }
    ],
    activeAccountId: 'account'
  }
  const source = observedProviderAccounts(target, 'claude')
  const resume = vi.fn()
  const signIn = vi.fn()
  const delivery: AgentSessionHeldDelivery = {
    delivered: false,
    state: 'held',
    failureId: 'failed-turn',
    reason: { kind: 'worker_failed', failure: 'sign-in' },
    provider: 'claude',
    target: { sessionId: 'worker' },
    failedAtTime: 100,
    waiting: 2
  }
  render(
    <TooltipProvider>
      <NativeChatWorkerFailureStatus
        delivery={delivery}
        target={target}
        workerName="Build worker"
        pending={false}
        onResume={resume}
        onSignIn={signIn}
      />
      <NativeChatQueueHeader
        count={2}
        attentionCaption={null}
        pause={{ reason: 'failed', delivery }}
        queuePending={null}
        clearCapable={true}
        expanded={false}
        listId="held"
        onClearAll={() => {}}
        onResume={resume}
      />
    </TooltipProvider>,
    { wrapper: TranslationScopeProvider }
  )
  const action = screen.getByRole('button', { name: 'Resume' })
  expect(action).toBeVisible()
  expect(action).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(signIn).toHaveBeenCalledOnce()
  await act(async () => {
    const release = source.subscribe(() => {})
    snapshot.accounts[0]!.lastAuthenticatedAt = 200
    source.setAccounts(snapshot)
    release()
  })
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  expect(resume).not.toHaveBeenCalled()
  fireEvent.click(action)
  expect(resume).toHaveBeenCalledOnce()
})
