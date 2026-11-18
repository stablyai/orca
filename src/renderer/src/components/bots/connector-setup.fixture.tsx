import { defineFixture } from '../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { cancelConnectorConnect } from '@/lib/connector-connect-state'
import type { Bot } from '../../../../shared/bot-types'
import type { ConnectorLinearWorkspace } from '../../../../shared/connector-bot-linear-contract'
import type { ConnectorGitHubInstallation } from '../../../../shared/connector-bot-github-contract'
import {
  openGitHubInstall,
  resetGitHubInstallForTests,
  useGitHubInstallRecord
} from '@/lib/bot-github-install-record'
import { BotGitHubSetupDialog } from './github/BotGitHubSetupDialog'
import { BotLinearSetupDialog } from './linear/BotLinearSetupDialog'
import { BotSlackCard } from './slack/BotSlackCard'
import { BotSlackSetupDialog } from './slack/BotSlackSetupDialog'

const triage: Bot = {
  id: 'bot-triage',
  name: 'Triage bot',
  hostId: 'local',
  folder: 'triage',
  folderWorkspaceId: 'fw-triage',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const acme = { workspaceId: 'org-acme', workspaceName: 'Acme', urlKey: 'acme' }
// Bots already answering in Acme and on GitHub, so "Not you?" has something to confirm.
const scout: Bot = {
  ...triage,
  id: 'bot-scout',
  name: 'Scout',
  folder: 'scout',
  linearWorkspaces: [acme],
  github: {}
}

function linearWorkspace(fields: Partial<ConnectorLinearWorkspace>): ConnectorLinearWorkspace {
  return {
    workspaceId: acme.workspaceId,
    name: acme.workspaceName,
    urlKey: acme.urlKey,
    installed: true,
    userId: 'L-dana',
    userName: 'Dana Lee',
    defaultBotId: null,
    ...fields
  }
}

const orcaBotTest: ConnectorGitHubInstallation = {
  installationId: '1',
  accountLogin: 'dana',
  repositories: [{ fullName: 'dana/orca-bot-test' }]
}

const notAnswered = async (): Promise<{ ok: false; error: string }> => ({
  ok: false,
  error: 'fixture'
})
// A browser trip that never comes back: the fixture shows the dialog, not the browser.
const neverReturns = (): Promise<never> => new Promise(() => {})

// The Linear host fake, so a fixture can change one of its answers.
let linearFake: Record<string, unknown> = {}

function stubConnectors(
  linear: ConnectorLinearWorkspace[],
  installations: ConnectorGitHubInstallation[]
): void {
  publishBots([triage, scout])
  linearFake = {
    state: async () => ({
      ok: true,
      value: { installUrl: 'https://connector.example/linear/install', workspaces: linear }
    }),
    members: notAnswered,
    connect: neverReturns,
    cancelConnect: async () => undefined,
    unlink: neverReturns,
    redeem: neverReturns
  }
  Reflect.set(window.api, 'botLinear', linearFake)
  Reflect.set(window.api, 'botGitHub', {
    state: async () => ({
      ok: true,
      value: {
        installUrl: 'https://github.com/apps/orca-ide/installations/new',
        account: { userId: '42', login: 'dana' },
        installations,
        defaultBotId: null
      }
    }),
    users: notAnswered,
    connect: neverReturns,
    cancelConnect: async () => undefined,
    unlink: neverReturns
  })
  // The page stays warm between fixtures: a trip an earlier one started must not show here.
  withBotConnectorRuntime(window.api)

  cancelConnectorConnect('local', 'linear')
  cancelConnectorConnect('local', 'github')
}

async function clickWhenShown(name: string): Promise<void> {
  for (let tries = 0; tries < 50; tries++) {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name
    )
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const linearDialog = (bot: Bot = triage): React.JSX.Element => (
  <ConfirmationDialogProvider>
    <BotLinearSetupDialog bot={bot} open onOpenChange={() => {}} />
  </ConfirmationDialogProvider>
)
/** GitHub's setup dialog as Add connector opens it: from the saved setup record. */
function GitHubSetup({ bot }: { bot: Bot }): React.JSX.Element | null {
  const record = useGitHubInstallRecord()
  return record ? (
    <ConfirmationDialogProvider>
      <BotGitHubSetupDialog bot={bot} record={record} />
    </ConfirmationDialogProvider>
  ) : null
}
function openGitHubSetup(bot: Bot): void {
  resetGitHubInstallForTests()
  openGitHubInstall(bot)
}
const gitHubDialog = (): React.JSX.Element => <GitHubSetup bot={triage} />

export const linearOneWorkspace = defineFixture({
  width: 1100,
  setup: () => stubConnectors([linearWorkspace({})], [orcaBotTest]),
  render: () => linearDialog()
})

export const linearTwoWorkspaces = defineFixture({
  width: 1100,
  setup: () =>
    stubConnectors(
      [
        linearWorkspace({}),
        linearWorkspace({ workspaceId: 'org-beta', name: 'Beta', urlKey: 'beta' })
      ],
      [orcaBotTest]
    ),
  render: () => linearDialog()
})

export const linearNotYou = defineFixture({
  width: 1100,
  setup: () => stubConnectors([linearWorkspace({})], [orcaBotTest]),
  render: () => linearDialog(),
  interact: () => clickWhenShown('Not you?')
})

const issueTriage: Bot = { ...triage, name: 'GitHub issue triage', folder: 'github-issue-triage' }

export const linearConnect = defineFixture({
  width: 1100,
  setup: () => stubConnectors([], [orcaBotTest]),
  render: () => linearDialog(issueTriage)
})

// Turned on just now: how to ask, ready to copy.
export const linearDone = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([linearWorkspace({})], [orcaBotTest])
    publishBots([issueTriage])
    // Turn on saves the bot on its host, then reads the list again; answer both here.
    const on = { ...issueTriage, linearWorkspaces: [acme] }
    const call = window.api.runtime.call
    Reflect.set(window.api, 'runtime', {
      ...window.api.runtime,
      call: async (args: Parameters<typeof call>[0]) =>
        args.method === 'bots.update'
          ? { ok: true, result: { bot: on } }
          : args.method === 'bots.list'
            ? { ok: true, result: { bots: [on] } }
            : call(args)
    })
  },
  render: () => linearDialog(issueTriage),
  interact: () => clickWhenShown('Turn on GitHub issue triage')
})

export const gitHubOneInstall = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([], [orcaBotTest])
    openGitHubSetup(triage)
  },
  render: gitHubDialog
})

export const gitHubTwoInstalls = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors(
      [],
      [orcaBotTest, { installationId: '2', accountLogin: 'acme-org', repositories: null }]
    )
    openGitHubSetup(triage)
  },
  render: gitHubDialog
})

const longScout: Bot = { ...scout, name: 'Orchestration builder for the whole engineering team' }

// Scout is already on GitHub: setup ends on the done screen.
export const gitHubDone = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([], [orcaBotTest])
    openGitHubSetup(scout)
  },
  render: () => <GitHubSetup bot={scout} />
})

// A long bot name: the title ends in an ellipsis on one line, the full name on hover.
export const gitHubDoneLongName = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([], [orcaBotTest])
    openGitHubSetup(longScout)
  },
  render: () => <GitHubSetup bot={longScout} />
})

export const gitHubNotYou = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([], [orcaBotTest])
    openGitHubSetup(triage)
  },
  render: gitHubDialog,
  interact: () => clickWhenShown('Not you?')
})

// The bot in one Slack workspace, its card open on who can ask it.
const slackBot: Bot = {
  ...triage,
  slack: { appId: 'A1', teamId: 'T1' },
  members: [{ id: 'U-sam', name: 'Sam Lee' }]
}

export const slackInstalled = defineFixture({
  width: 1100,
  setup: () => {
    publishBots([slackBot])
    Reflect.set(window.api, 'botSlack', {
      state: async () => ({
        ok: true,
        value: {
          state: 'installed',
          teamId: 'T1',
          teamName: 'Acme',
          appId: 'A1',
          botUserId: 'UB',
          installerUserId: 'U-dana'
        }
      }),
      members: notAnswered
    })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <BotSlackCard bot={slackBot} defaultOpen />
    </ConfirmationDialogProvider>
  )
})

// Shared with two people and Full access: the open setup the advice is for.
const openTriage: Bot = {
  ...triage,
  permissionMode: 'full-access',
  members: [
    { id: 'L-bea', name: 'Bea Park', source: 'linear', workspaceId: acme.workspaceId },
    { id: 'L-cy', name: 'Cy Ortiz', source: 'linear', workspaceId: acme.workspaceId }
  ]
}

export const linearOpenSetup = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([linearWorkspace({})], [orcaBotTest])
    publishBots([openTriage, scout])
  },
  render: () => (
    <ConfirmationDialogProvider>
      <BotLinearSetupDialog bot={openTriage} open onOpenChange={() => {}} />
    </ConfirmationDialogProvider>
  )
})

// Already on in Acme, opened from its row: the dialog only edits who can ask.
export const linearAlreadyOn = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([linearWorkspace({})], [orcaBotTest])
    publishBots([{ ...openTriage, permissionMode: 'ask', linearWorkspaces: [acme] }])
  },
  render: () => (
    <ConfirmationDialogProvider>
      <BotLinearSetupDialog
        bot={{ ...openTriage, permissionMode: 'ask', linearWorkspaces: [acme] }}
        workspaceId={acme.workspaceId}
        open
        onOpenChange={() => {}}
      />
    </ConfirmationDialogProvider>
  )
})

// Linear's people search fails: the picker says so and offers Try again.
export const linearPickerFailed = defineFixture({
  width: 1100,
  setup: () => stubConnectors([linearWorkspace({})], [orcaBotTest]),
  render: () => linearDialog(),
  interact: async () => {
    await clickWhenShown('Add')
    for (let tries = 0; tries < 50 && !document.querySelector('[role="alert"]'); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

const people = async (): Promise<unknown> => ({
  ok: true,
  value: {
    members: [
      { id: 'L-bea', name: 'Bea Park', handle: 'bea' },
      { id: 'L-cy', name: 'Cy Ortiz', handle: 'cy' }
    ],
    complete: true
  }
})

// Adding someone still asks first, with the same reach the block lists.
export const linearConfirm = defineFixture({
  width: 1100,
  setup: () => {
    stubConnectors([linearWorkspace({})], [orcaBotTest])
    linearFake.members = people
  },
  render: () => linearDialog(),
  interact: async () => {
    await clickWhenShown('Add')
    for (let tries = 0; tries < 50; tries++) {
      const option = [...document.querySelectorAll('[cmdk-item]')].find((item) =>
        item.textContent?.includes('Bea Park')
      )
      if (option instanceof HTMLElement) {
        option.click()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await clickWhenShown('Add 1 person')
  }
})

const slackState = (): unknown => ({
  ok: true,
  value: {
    state: 'installed',
    teamId: 'T1',
    teamName: 'Acme',
    appId: 'A1',
    botUserId: 'UB',
    installerUserId: 'U-dana'
  }
})

// Slack's setup, once installed: who can ask, before Done.
export const slackSetupInstalled = defineFixture({
  width: 1100,
  setup: () => {
    publishBots([slackBot])
    Reflect.set(window.api, 'botSlack', { state: async () => slackState(), members: notAnswered })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <BotSlackSetupDialog bot={slackBot} teamId="T1" open onOpenChange={() => {}} />
    </ConfirmationDialogProvider>
  )
})

// A Full access bot's Slack row: the advice and what Sam reaches.
export const slackRowOpenSetup = defineFixture({
  width: 720,
  setup: () => {
    publishBots([{ ...slackBot, permissionMode: 'full-access', agent: 'codex' }])
    Reflect.set(window.api, 'botSlack', { state: async () => slackState(), members: notAnswered })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <BotSlackCard
        bot={{ ...slackBot, permissionMode: 'full-access', agent: 'codex' }}
        defaultOpen
      />
    </ConfirmationDialogProvider>
  )
})
