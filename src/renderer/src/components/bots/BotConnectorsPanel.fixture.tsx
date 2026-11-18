import { defineFixture } from '../../component-fixtures/component-fixture'
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
