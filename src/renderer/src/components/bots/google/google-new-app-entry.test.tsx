// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_SIGN_IN_EXPIRED } from '../../../../../shared/google/google-connect-types'
import { GoogleSignInFailed } from './GoogleSignInTrouble'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'
import { GoogleUseAnotherAccountMenu } from './GoogleUseAnotherAccountMenu'
import { useGoogleNewApp } from './use-google-new-app'

const capability = vi.hoisted(() => ({ supported: true }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => capability.supported
}))

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

describe('Set up a new Google app on a paired server', () => {
  function NewApp({ cancel, start }: { cancel: () => void; start: () => void }): React.JSX.Element {
    const { newApp, updateNotice } = useGoogleNewApp(
      { kind: 'environment', environmentId: 'server-1' },
      { cancel },
      start
    )
    return (
      <>
        <button onClick={newApp}>{NEW_APP}</button>
        {updateNotice}
      </>
    )
  }

  it('starts when the server can, and asks to update it when it can’t', async () => {
    for (const supported of [true, false]) {
      capability.supported = supported
      const cancel = vi.fn()
      const start = vi.fn()
      render(<NewApp cancel={cancel} start={start} />)
      await act(async () => fireEvent.click(screen.getByRole('button', { name: NEW_APP })))
      expect(start).toHaveBeenCalledTimes(supported ? 1 : 0)
      expect(cancel).toHaveBeenCalledTimes(supported ? 1 : 0)
      expect(Boolean(screen.queryByText(/^Update Orca on .+ to set up a new Google app\.$/))).toBe(
        !supported
      )
      cleanup()
    }
  })
})
