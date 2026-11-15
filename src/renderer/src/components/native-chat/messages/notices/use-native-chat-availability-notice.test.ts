// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'

const signIn = { signIn: vi.fn(), signingIn: false }

describe('useNativeChatAvailabilityNotice: an Orca Cloud agent signed in inside the workspace', () => {
  const base = {
    unavailable: { reason: 'notSignedIn' as const },
    setup: { signIn, install: null },
    agent: 'claude' as const,
    launchFailure: null,
    journalItems: []
  }

  it('says the agent needs a sign-in inside the workspace, with a button that opens the login terminal', () => {
    const { result } = renderHook(() =>
      useNativeChatAvailabilityNotice({
        ...base,
        signInInside: {
          text: 'Claude needs you to sign in inside this workspace',
          actionLabel: 'Open terminal to sign in'
        }
      })
    )
    expect(result.current?.text).toBe('Claude needs you to sign in inside this workspace')
    expect(result.current?.action?.label).toBe('Open terminal to sign in')
    result.current?.action?.onClick()
    expect(signIn.signIn).toHaveBeenCalledOnce()
  })

  it('keeps the host’s own words without it', () => {
    const { result } = renderHook(() => useNativeChatAvailabilityNotice(base))
    expect(result.current?.text).not.toContain('inside this workspace')
    expect(result.current?.action?.label).toBe('Sign in')
  })
})
