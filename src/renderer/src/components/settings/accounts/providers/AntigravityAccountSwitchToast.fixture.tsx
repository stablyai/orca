import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Toaster } from '../../../ui/sonner'
import {
  announceAntigravityAccountSwitch,
  announceAntigravityAccountSwitchFailure
} from '@/lib/provider-accounts/antigravity-account-switch-toasts'

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
