import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { openBotConnectorPage } from './bot-connector-page'
import {
  base,
  botsChanged,
  clickWhenShown,
  empty,
  named,
  Panel,
  settle,
  slackOnly,
  stub,
  switchedToCodex,
  twoOfEach
} from './bot-connectors-host-fixture'

export const list = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true }),
  render: () => <Panel bot={base} />
})

/** The side panel at its narrowest: every row's logo is one 20 px bare mark, in line with the header. */
export const listNarrow = defineFixture({
  width: 300,
  setup: () => stub({ linearLinked: true, composio: true }),
  render: () => <Panel bot={base} />
})

/** Seeded Datadog MCP tool row alongside the connector list. */
export const datadogToolRow = defineFixture({
  width: 372,
  setup: () =>
    stub({
      linearLinked: true,
      composio: true,
      owned: [{ name: 'datadog', detail: 'https://mcp.datadoghq.com/v1/mcp', remote: true }]
    }),
  render: () => <Panel bot={base} />
})

export const composioRowOpen = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true }),
  render: () => <Panel bot={base} />,
  interact: () => clickWhenShown(named('Jira'))
})

export const slackOnlyRow = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: false }),
  render: () => <Panel bot={slackOnly} />
})

export const needsSignIn = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: false, composio: true }),
  render: () => <Panel bot={base} />
})

export const none = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: false }),
  render: () => <Panel bot={empty} />
})

export const addDialog = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: true }),
  render: () => <Panel bot={base} />,
  interact: () => clickWhenShown(named('Add'))
})

export const addDialogSigningIn = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: true }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await clickWhenShown(named('Add'))
    await clickWhenShown(named('Notion'))
  }
})

/** The key is refused after the apps were read: they stay listed, each with Fix key, and count. */
export const composioKeyRejected = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true, keys: ['ok', 'rejected'] }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await settle(300)
    botsChanged()
    await settle(300)
  }
})

/** The sign-ins couldn't be read and none are known: one Composio row says so, not "no connectors". */
export const composioUnread = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true, connectionsFail: true }),
  render: () => <Panel bot={empty} />
})

/** The browser sign-in ended without a connection: the dialog says so and offers Try again. */
export const addDialogSignInFailed = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: true }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await clickWhenShown(named('Add'))
    await clickWhenShown(named('Notion'))
    await settle(400)
    botsChanged()
    await settle(300)
  }
})

/** Vercel and an app added by URL, signed in, among the other connectors. */
export const appsSignedIn = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true, tools: true }),
  render: () => <Panel bot={base} />
})

/** Switched to Codex after signing in on Claude Code: Vercel needs sign-in again, so it opens. */
export const appsNeedSignInAfterAgentSwitch = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true, tools: true }),
  render: () => <Panel bot={switchedToCodex} />
})

/** All apps keeps Vercel listed once added, with Manage in place of Add. */
export const addDialogAppAdded = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: true, tools: true }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await clickWhenShown(named('Add'))
    await settle(300)
  }
})

/** A category keeps its added apps too. */
export const addDialogCategoryAppAdded = defineFixture({
  width: 900,
  setup: () => stub({ linearLinked: true, composio: true, tools: true }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await clickWhenShown(named('Add'))
    await clickWhenShown((button) => button.textContent?.trim().startsWith('Coding') === true)
    await settle(300)
  }
})

/** Two GitHub orgs, two Slack workspaces, and GitHub through Composio too: each title names its own. */
export const sameServiceRows = defineFixture({
  width: 372,
  setup: () => stub({ linearLinked: true, composio: true, sameService: true }),
  render: () => <Panel bot={twoOfEach} />
})

/** The same rows narrower: the service gives way before the name. */
export const sameServiceRowsNarrow = defineFixture({
  width: 260,
  setup: () => stub({ linearLinked: true, composio: true, sameService: true }),
  render: () => <Panel bot={twoOfEach} />
})

// Opens a row as a click would, without the focus ring a scripted click leaves on Back.
const openRow = async (name: string): Promise<void> => {
  // After the connectors are read, so the row is the loaded one.
  await settle(500)
  await clickWhenShown(named(name))
  await settle(250)
  const focused = document.activeElement
  if (focused instanceof HTMLElement) {
    focused.blur()
  }
}

const fresh = (options: Parameters<typeof stub>[0]): void => {
  stub(options)
  // The page stays warm between fixtures; each starts on the list.
  openBotConnectorPage(null)
}

/** A connector's own page, opened from its row. */
export const slackPage = defineFixture({
  width: 420,
  setup: () => fresh({ linearLinked: true, composio: false }),
  render: () => <Panel bot={base} />,
  interact: () => openRow('Slack · Globex')
})

export const slackPageNarrow = defineFixture({
  width: 300,
  setup: () => fresh({ linearLinked: true, composio: false }),
  render: () => <Panel bot={base} />,
  interact: () => openRow('Slack · Globex')
})

/** A connector that needs the owner: its fix in the list row, then in its page's header. */
export const needsOwnerNarrow = defineFixture({
  width: 300,
  setup: () => fresh({ linearLinked: false, composio: false }),
  render: () => <Panel bot={base} />
})

export const needsOwnerPageNarrow = defineFixture({
  width: 300,
  setup: () => fresh({ linearLinked: false, composio: false }),
  render: () => <Panel bot={base} />,
  interact: () => openRow('Linear · Globex')
})

export const remoteOwnerOnlyPageNarrow = defineFixture({
  width: 300,
  setup: () => {
    fresh({ linearLinked: false, composio: false, host: 'paste' })
    const environment = publicRuntimeEnvironment({ id: 'build-server', pairingRevision: 1 })
    const store = useAppStore.getState()
    store.setRuntimeEnvironments([environment])
    store.applyRuntimeHostStatusSnapshot({
      environmentId: environment.id,
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      verification: 'verified',
      transport: 'ready',
      status: {
        ...createCompatibleRuntimeStatusResponse(environment.id).result,
        machineName: 'Build server (Ubuntu 24.04)'
      }
    })
  },
  render: () => <Panel bot={base} />,
  interact: () => openRow('Linear · Globex')
})

/** The longest name, in the narrowest pane: the heading wraps. */
export const longNamePageNarrow = defineFixture({
  width: 300,
  setup: () => fresh({ linearLinked: true, composio: false, sameService: true }),
  render: () => <Panel bot={twoOfEach} />,
  interact: () => openRow('Slack · Acme Design Partners')
})

export const onlyOneConnector = defineFixture({
  width: 420,
  setup: () => fresh({ linearLinked: true, composio: false }),
  render: () => <Panel bot={slackOnly} />
})

export const googlePage = defineFixture({
  width: 420,
  setup: () => fresh({ linearLinked: true, composio: false }),
  render: () => <Panel bot={base} />,
  interact: () => openRow('Google')
})

/** The Google page's menu: add another account, as GitHub's does. */
export const googlePageMenu = defineFixture({
  width: 420,
  setup: () => fresh({ linearLinked: true, composio: false }),
  render: () => <Panel bot={base} />,
  interact: async () => {
    await openRow('Google')
    const trigger = [...document.querySelectorAll<HTMLElement>('button')].find(
      (button) => button.getAttribute('aria-label') === 'Google actions'
    )
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await settle(200)
  }
})
