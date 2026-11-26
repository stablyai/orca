import { defineFixture } from '../../component-fixtures/component-fixture'
import type { BotOwnTool } from '../../../../shared/bot-tools'
import { base, clickWhenShown, named, Panel, settle, stub } from './bot-connectors-host-fixture'

// The web and the phone, whose bots run on their paired server: the server signs the bot in, the
// page opens on this device and the address it lands on is pasted back.
const acme = (signIn: BotOwnTool['signIn']): BotOwnTool => ({
  name: 'acme-notes',
  detail: 'https://mcp.acme-notes.example/mcp',
  remote: false,
  signIn
})
const signIn = async (): Promise<void> => {
  await clickWhenShown(named('Sign in'))
  await settle(1500)
}

/** Web: Sign in opened the app's page in this browser; paste the address it lands on. */
export const webPaste = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      host: 'paste',
      owned: [acme({ state: 'signed-out' })]
    }),
  render: () => <Panel bot={base} />,
  interact: signIn
})

/** Phone: the same row at phone width. */
export const phonePaste = defineFixture({
  width: 340,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      host: 'paste',
      owned: [acme({ state: 'signed-out' })]
    }),
  render: () => <Panel bot={base} />,
  interact: signIn
})

/** The pasted address is being exchanged and stored on the server. */
export const finishing = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      host: 'finishing',
      owned: [acme({ state: 'signed-out' })]
    }),
  render: () => <Panel bot={base} />,
  interact: signIn
})

/** The server runs an Orca from before it could sign in for another device. */
export const updateNeeded = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      host: 'old-host',
      owned: [acme({ state: 'signed-out' })]
    }),
  render: () => <Panel bot={base} />,
  interact: signIn
})

/** Add by URL from the web: the sign-in waits on the pasted address. */
export const webAddByUrlPaste = defineFixture({
  width: 900,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      host: 'paste',
      owned: [],
      added: acme({ state: 'signed-out' })
    }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await clickWhenShown(named('Add'))
    await clickWhenShown(named('Add by URL'))
    for (let tries = 0; tries < 60 && !document.getElementById('bot-tool-source'); tries++) {
      await settle(50)
    }
    const input = document.getElementById('bot-tool-source')
    if (input instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'https://mcp.acme-notes.example/mcp'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await settle(200)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')]
    buttons.find((button) => button.textContent?.trim() === 'Add')?.click()
    await settle(600)
  }
})
