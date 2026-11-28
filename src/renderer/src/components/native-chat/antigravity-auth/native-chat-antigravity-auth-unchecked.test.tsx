// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AntigravityChatAuthDetection } from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { callAntigravityChatAuthConfig } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { startAntigravityChatSignIn } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import {
  NativeChatAntigravityAuthProvider,
  useNativeChatAntigravityAuth
} from './native-chat-antigravity-auth'

let detection: AntigravityChatAuthDetection

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatAuthConfig: vi.fn(async () => ({ method: 'gemini-api-key' }))
}))
vi.mock('@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection', () => ({
  readAntigravityChatAuthDetection: () => detection,
  refreshAntigravityChatAuthDetection: async () => true,
  refreshAntigravityChatAuthDetectionAt: () => {},
  useAntigravityChatAuthDetection: () => detection
}))
vi.mock('@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status', () => ({
  readAntigravityChatSignInSnapshot: () => null,
  startAntigravityChatSignIn: vi.fn(async () => {}),
  subscribeAntigravityChatSignIns: () => () => {}
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/components/provider-accounts/use-antigravity-chat-sign-in', () => ({
  useAntigravityChatSignIn: () => {}
}))
vi.mock('@/components/provider-accounts/open-antigravity-sign-in-settings', () => ({
  openAntigravitySignInSettings: () => {}
}))
vi.mock('../pane/ownership/native-chat-view-memory', () => ({
  useNativeChatViewGuard: <T,>(_key: string, initial: T) => {
    const [value, setValue] = useState(initial)
    const latest = useRef(value)
    latest.current = value
    const set = (next: T) => {
      latest.current = next
      setValue(next)
    }
    return [value, set, () => latest.current] as const
  }
}))

function SwitchToGoogle(): React.JSX.Element {
  const auth = useNativeChatAntigravityAuth()
  return (
    <button type="button" onClick={() => auth?.switchTo('oauth-personal')}>
      Use Google account
    </button>
  )
}

function renderSwitch(): void {
  render(
    <NativeChatAntigravityAuthProvider
      target={{ host: { kind: 'local' }, agy: 'yours', managedVersion: null, ownLogin: false }}
    >
      <SwitchToGoogle />
    </NativeChatAntigravityAuthProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use Google account' }))
}

const base: AntigravityChatAuthDetection = {
  method: 'gemini-api-key',
  googleSignIn: { personal: false, business: false },
  apiKey: { available: true, source: 'saved' },
  adc: { available: false, project: null },
  liveChats: 0
}

beforeEach(() => {
  vi.mocked(startAntigravityChatSignIn).mockClear()
  vi.mocked(callAntigravityChatAuthConfig).mockClear()
  vi.mocked(toast.success).mockClear()
})

afterEach(cleanup)

// Incident replay, worst visible effect: one keychain read that didn't answer made Orca itself
// open a Google sign-in for a login that was there the whole time.
it('never starts a sign-in when the Google login could not be checked', async () => {
  detection = { ...base, googleSignIn: { personal: false, business: false, personalUnchecked: true } }
  renderSwitch()
  // The switch is saved, then reported as done.
  await waitFor(() => expect(toast.success).toHaveBeenCalled())
  expect(callAntigravityChatAuthConfig).toHaveBeenCalledWith(
    { kind: 'local' },
    expect.objectContaining({ method: 'oauth-personal' })
  )
  expect(startAntigravityChatSignIn).not.toHaveBeenCalled()
})

it('still starts a sign-in when the host definitively has no Google login', async () => {
  detection = base
  renderSwitch()
  await waitFor(() => expect(startAntigravityChatSignIn).toHaveBeenCalledWith({ kind: 'local' }, 'signIn'))
})
