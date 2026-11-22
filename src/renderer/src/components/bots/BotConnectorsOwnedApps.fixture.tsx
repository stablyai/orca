import { defineFixture } from '../../component-fixtures/component-fixture'
import type { BotOwnTool } from '../../../../shared/bot-tools'
import { base, clickWhenShown, named, Panel, settle, stub } from './bot-connectors-host-fixture'

// Apps Orca signs in to itself, in the Connectors list and Add to <bot>.
/** The Add button in the dialog row of `app`. */
const addFor = (app: string) => (button: HTMLElement) =>
  button.textContent?.trim() === 'Add' &&
  button.closest('[role="dialog"]') !== null &&
  button.parentElement?.parentElement?.textContent?.includes(app) === true

const vercelOwned = (signIn: BotOwnTool['signIn']): BotOwnTool => ({
  name: 'vercel',
  detail: 'https://mcp.vercel.com',
  remote: false,
  signIn
})
/** A made-up app, so no real app reads as unsupported. */
const acmeOwned = (signIn: BotOwnTool['signIn']): BotOwnTool => ({
  name: 'acme-notes',
  detail: 'https://mcp.acme-notes.example/mcp',
  remote: false,
  signIn
})
const docsOwned = (signIn: BotOwnTool['signIn']): BotOwnTool => ({
  name: 'globex-docs',
  detail: 'https://docs.globex.example/mcp',
  remote: false,
  signIn
})

/** Apps Orca signs in to: Vercel signed in, an app by URL whose sign-in the app ended. */
export const ownedAppsRows = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      owned: [vercelOwned({ state: 'signed-in', limited: false }), docsOwned({ state: 'lost' })]
    }),
  render: () => <Panel bot={base} />
})

/** Vercel signed in, opened: Orca holds the sign-in, so any agent the bot runs uses it. */
export const ownedAppSignedInOpen = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      owned: [vercelOwned({ state: 'signed-in', limited: false })]
    }),
  render: () => <Panel bot={base} />,
  interact: () => clickWhenShown(named('Vercel'))
})

/** The host kept that the app won't let Orca register: any window shows it, no Sign in needed. */
export const ownedAppUnsupported = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      owned: [acmeOwned({ state: 'signed-out', problem: 'unsupported' })]
    }),
  render: () => <Panel bot={base} />
})

/** The host kept that the app didn't answer the last sign-in: Can't reach, with Try again. */
export const ownedAppUnreachable = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      owned: [acmeOwned({ state: 'signed-out', problem: 'unreachable' })]
    }),
  render: () => <Panel bot={base} />
})

/** Adding Vercel: Orca opened the browser and waits for its own page to come back. */
export const addDialogOwnedConnecting = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: false, connect: 'waiting', owned: [] }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await clickWhenShown(named('Add'))
    await clickWhenShown(addFor('Vercel'))
    await settle(300)
  }
})

/** An app by URL refused Orca's registration while adding: not supported yet, with Remove. */
export const addDialogOwnedUnsupported = defineFixture({
  width: 900,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      connect: 'unsupported',
      owned: [],
      added: acmeOwned({ state: 'signed-out' })
    }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await addByUrl('https://mcp.acme-notes.example/mcp')
    await settle(2600)
  }
})

async function addByUrl(address: string): Promise<void> {
  await clickWhenShown(named('Add'))
  await clickWhenShown(named('Add by URL'))
  for (let tries = 0; tries < 60 && !document.getElementById('bot-tool-source'); tries++) {
    await settle(50)
  }
  const input = document.getElementById('bot-tool-source')
  if (input instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, address)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await settle(200)
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')]
  buttons.find((button) => button.textContent?.trim() === 'Add')?.click()
  await settle(400)
}

/** Add by URL, an address whose sign-in Orca can't make yet: not added, and it says why. */
export const addByUrlUnsupported = defineFixture({
  width: 900,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      owned: [],
      addRefused: 'This app isn’t supported yet.'
    }),
  render: () => <Panel bot={base} />,
  interact: () => addByUrl('https://mcp.example.com/mcp')
})

/** Add by URL, an address that didn't answer: not added, try again. */
export const addByUrlUnreachable = defineFixture({
  width: 900,
  setup: () =>
    stub({
      linearLinked: true,
      composio: false,
      owned: [],
      addRefused: 'Can’t reach this app. Check the address, then try again.'
    }),
  render: () => <Panel bot={base} />,
  interact: () => addByUrl('https://mcp.example.com/mcp')
})

/** Add by URL, an address that needs a sign-in: Orca signs in to it, in the browser. */
export const addByUrlNeedsSignIn = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: false, connect: 'waiting', owned: [] }),
  render: () => <Panel bot={base} />,
  interact: () => addByUrl('https://mcp.vercel.com')
})
