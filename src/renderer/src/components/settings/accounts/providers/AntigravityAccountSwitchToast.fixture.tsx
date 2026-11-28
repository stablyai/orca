import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Toaster } from '../../../ui/sonner'
import {
  announceAntigravityAccountSwitch,
  announceAntigravityAccountSwitchFailure
} from '@/lib/provider-accounts/antigravity-account-switch-toasts'
import {
  announceAccountRestart,
  announceHostAccountMove
} from '@/lib/provider-accounts/account-switch-toasts'
import { antigravityAccountSwitchCopy } from '@/lib/provider-accounts/account-switch-copy'

// The toasts Settings shows when a saved Antigravity account is selected, from the production code.
function Stage(): React.JSX.Element {
  return (
    <>
      <div className="h-[150px]" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

async function waitForToast(frame: HTMLElement): Promise<void> {
  const deadline = performance.now() + 3000
  while (!frame.ownerDocument.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('The toast never appeared')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // The toaster is fixed to the viewport corner; pin it inside the frame for the shot.
  const toaster = frame.ownerDocument.querySelector<HTMLElement>('[data-sonner-toaster]')
  if (toaster) {
    Object.assign(toaster.style, {
      position: 'absolute',
      top: '130px',
      left: '8px',
      right: 'auto',
      bottom: 'auto'
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
}

export const switched = defineFixture({
  width: 420,
  render: () => <Stage />,
  interact: async (frame) => {
    announceAntigravityAccountSwitch(
      {
        accounts: [
          {
            id: 'work',
            email: 'work@example.com',
            subject: 'work',
            authMethod: 'consumer',
            createdAt: 0,
            updatedAt: 0
          }
        ],
        activeAccountId: 'work',
        selectedAccountId: 'work',
        currentAccount: null
      },
      'work'
    )
    await waitForToast(frame)
  }
})

// A switch under Always restart, or one made from the CLI under Ask.
export const restartingTerminals = defineFixture({
  width: 420,
  render: () => <Stage />,
  interact: async (frame) => {
    announceAccountRestart(
      antigravityAccountSwitchCopy(),
      2,
      'personal@example.com',
      1,
      () => {},
      1
    )
    await waitForToast(frame)
  }
})

// A server with no window left its terminals running under Ask; only the switching client can answer.
export const serverAsks = defineFixture({
  width: 420,
  render: () => <Stage />,
  interact: async (frame) => {
    announceHostAccountMove(
      antigravityAccountSwitchCopy(),
      { restarting: 0, notMoved: 2, canRestart: 2 },
      { previous: 'work@example.com', next: 'personal@example.com' },
      async () => undefined
    )
    await waitForToast(frame)
  }
})

export const switchFailed = defineFixture({
  width: 420,
  render: () => <Stage />,
  interact: async (frame) => {
    announceAntigravityAccountSwitchFailure(
      new Error('Antigravity is signing in. Select an account after it finishes.')
    )
    await waitForToast(frame)
  }
})
