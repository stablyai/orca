import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { GoogleAccountSettings } from './GoogleAccountSettings'

const ready = (service: string) => ({ service, state: 'ready' })
const services = [ready('gmail'), ready('calendar'), ready('drive'), ready('contacts')]
const work = { email: 'dana@acme.com', status: 'connected', services, connectedAt: 1 }
const personal = { email: 'dana.lee@gmail.com', status: 'connected', services, connectedAt: 2 }
const host = {
  client: { clientId: 'fixture.apps.googleusercontent.com', projectId: 'fixture' },
  accounts: [work, personal],
  defaultAccount: 'dana@acme.com',
  bots: [{ id: 'bot-scout', name: 'Scout' }]
}

function stubGoogle(google: Record<string, unknown>): void {
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) =>
      method === 'google.status'
        ? { ok: true, result: google }
        : { ok: false, error: { code: 'runtime_error', message: 'not in this fixture' } }
  })
}

function Settings(): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div className="p-4">
        <GoogleAccountSettings target={{ kind: 'local' }} />
      </div>
    </ConfirmationDialogProvider>
  )
}

async function clickWhenShown(label: string): Promise<void> {
  for (let tries = 0; tries < 50; tries++) {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
    )
    if (button) {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// Two accounts: the default, and Set as default on the other.
export const twoAccounts = defineFixture({
  width: 720,
  setup: () => stubGoogle(host),
  render: () => <Settings />
})

export const oneAccount = defineFixture({
  width: 720,
  setup: () => stubGoogle({ ...host, accounts: [work] }),
  render: () => <Settings />
})

export const rowMenu = defineFixture({
  width: 720,
  setup: () => stubGoogle(host),
  render: () => <Settings />,
  interact: () => clickWhenShown('dana@acme.com actions')
})

// Removing the default says which account takes over.
export const removeDefault = defineFixture({
  width: 720,
  setup: () => stubGoogle(host),
  render: () => <Settings />,
  interact: async () => {
    await clickWhenShown('dana@acme.com actions')
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === 'Remove from this computer'
    )
    ;(item as HTMLElement | undefined)?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

// The default signed out at Google, and a service the other account didn't allow.
export const needsFixing = defineFixture({
  width: 720,
  setup: () =>
    stubGoogle({
      ...host,
      accounts: [
        { ...work, status: 'reconnect' },
        {
          ...personal,
          services: [
            ready('gmail'),
            { service: 'calendar', state: 'needs-permission' },
            ready('drive')
          ]
        }
      ]
    }),
  render: () => <Settings />
})

// A server on an Orca too old to keep a default: no add, no Set as default.
export const oldHost = defineFixture({
  width: 720,
  setup: () => stubGoogle({ ...host, accounts: [work], defaultAccount: undefined }),
  render: () => <Settings />
})
