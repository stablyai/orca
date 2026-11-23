// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_SIGN_IN_EXPIRED } from '../../../../../shared/google/google-connect-types'
import { GoogleSignInFailed } from './GoogleSignInTrouble'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'
import { GoogleUseAnotherAccountMenu } from './GoogleUseAnotherAccountMenu'

const LINE = 'Seeing ‘Access blocked’?'
const NEW_APP = 'Set up a new Google app'

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Use another account', () => {
  it('signs in through the current app, or sets up a new one', async () => {
    const onSignIn = vi.fn()
    const onNewApp = vi.fn()
    const open = async (): Promise<void> => {
      const trigger = screen.getByRole('button', { name: 'Use another account' })
      await act(async () => {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
    }
    render(<GoogleUseAnotherAccountMenu onSignIn={onSignIn} onNewApp={onNewApp} />)

    await open()
    expect(screen.getByText('Uses your current Google app')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('Sign in with Google')))
    expect(onSignIn).toHaveBeenCalledTimes(1)
    expect(onNewApp).not.toHaveBeenCalled()

    await open()
    expect(
      screen.getByText('If your current app doesn’t work for this account or organization')
    ).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText(NEW_APP)))
    expect(onNewApp).toHaveBeenCalledTimes(1)
    expect(onSignIn).toHaveBeenCalledTimes(1)
  })
})

describe('the Access blocked line', () => {
  it('shows on the waiting card from the start and sets up a new app', () => {
    const onNewApp = vi.fn()
    render(
      <GoogleSignInWaiting
        state={{ kind: 'waiting', prompt: null }}
        onCancel={() => {}}
        onNewApp={onNewApp}
      />
    )
    expect(screen.getByText(LINE)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: NEW_APP }))
    expect(onNewApp).toHaveBeenCalledTimes(1)
  })

  it('shows under an expired sign-in only', () => {
    const onNewApp = vi.fn()
    const { rerender } = render(
      <GoogleSignInFailed error={GOOGLE_SIGN_IN_EXPIRED} onNewApp={onNewApp} />
    )
    expect(screen.getByRole('alert').textContent).toBe(GOOGLE_SIGN_IN_EXPIRED)
    fireEvent.click(screen.getByRole('button', { name: NEW_APP }))
    expect(onNewApp).toHaveBeenCalledTimes(1)

    rerender(<GoogleSignInFailed error="The Google sign-in failed." onNewApp={onNewApp} />)
    expect(screen.queryByText(LINE)).toBeNull()
  })
})
