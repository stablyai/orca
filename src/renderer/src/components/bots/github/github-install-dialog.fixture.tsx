import { defineFixture } from '../../../component-fixtures/component-fixture'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { stopAwaitingGitHub } from '@/lib/bot-github-state'
import { cancelConnectorConnect } from '@/lib/connector-connect-state'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeRepo } from '../../worktree-jump/worktree-jump-palette-test-fixtures'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  ConnectorGitHubInstallation,
  ConnectorGitHubLinkedAccount
} from '../../../../../shared/connector-bot-github-contract'
import {
  openGitHubInstall,
  resetGitHubInstallForTests,
  useGitHubInstallRecord
} from '@/lib/bot-github-install-record'
import { BotGitHubSetupDialog } from './BotGitHubSetupDialog'
import { GitHubInstallPill } from './GitHubInstallPill'

const marketing: Bot = {
  id: 'bot-marketing',
  name: 'Marketing - X - Manager',
  hostId: 'local',
  folder: 'marketing',
  folderWorkspaceId: 'fw-marketing',
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

const stablyai: ConnectorGitHubInstallation = {
  installationId: '1',
  accountLogin: 'stablyai',
  repositories: [
    { fullName: 'stablyai/orca' },
    { fullName: 'stablyai/website' },
    { fullName: 'acme/widgets' }
  ]
}
// What GitHub's install page saved: a repository on the first install, and a new organization.
const afterGitHub: ConnectorGitHubInstallation[] = [
  {
    ...stablyai,
    repositories: [...(stablyai.repositories ?? []), { fullName: 'stablyai/handbook' }]
  },
  {
    installationId: '2',
    accountLogin: 'carol-labs',
    repositories: [{ fullName: 'carol-labs/press-kit' }]
  }
]

const triage: Bot = {
  ...marketing,
  id: 'bot-triage',
  name: 'GitHub issue triage',
  folder: 'github-issue-triage'
}

let installations: ConnectorGitHubInstallation[] = [stablyai]
let account: { userId: string; login: string } | null = { userId: '42', login: 'carol-gh' }
/** Several GitHub users linked to this Orca account; unset means only `account`. */
let accounts: ConnectorGitHubLinkedAccount[] | undefined
let shownBot = marketing
const neverReturns = (): Promise<never> => new Promise(() => {})

function stubGitHub(
  options: {
    bot?: Bot
    signedIn?: boolean
    with?: ConnectorGitHubInstallation[]
  } = {}
): void {
  delete document.documentElement.dataset.githubDialogShot
  installations = options.with ?? [stablyai]
  account = options.signedIn === false ? null : { userId: '42', login: 'carol-gh' }
  accounts = undefined
  shownBot = options.bot ?? marketing
  stopAwaitingGitHub('local')
  cancelConnectorConnect('local', 'github')
  resetGitHubInstallForTests()
  publishBots([shownBot])
  openGitHubInstall(shownBot)
  Reflect.set(window.api, 'botGitHub', {
    state: async () => ({
      ok: true,
      value: {
        installUrl: 'https://github.com/apps/orca-ide/installations/new',
        account,
        ...(accounts ? { accounts } : {}),
        installations,
        defaultBotId: null
      }
    }),
    users: async () => ({ ok: false, error: 'fixture' }),
    connect: neverReturns,
    cancelConnect: async () => undefined,
    unlink: neverReturns
  })
  Reflect.set(window.api, 'shell', { ...window.api.shell, openUrl: async () => undefined })
  withBotConnectorRuntime(window.api)
}

const WORKSPACE = makeWorktree({ id: 'repo-1::/marketing', repoId: 'repo-1', path: '/marketing' })
// Link setting = open in Orca, in the bot's workspace.
const inOrcaStore = {
  settings: { ...getDefaultSettings('/home/fixture'), openLinksInApp: true },
  activeWorktreeId: WORKSPACE.id,
  repos: [makeRepo()],
  worktreesByRepo: { 'repo-1': [WORKSPACE] }
}

/** The setup as the app mounts it: the dialog, or minimized to the pill. */
function Setup(): React.JSX.Element | null {
  const record = useGitHubInstallRecord()
  if (!record) {
    return null
  }
  return (
    <ConfirmationDialogProvider>
      <BotGitHubSetupDialog bot={shownBot} record={record} />
      {record.surface === 'pill' ? <GitHubInstallPill record={record} /> : null}
    </ConfirmationDialogProvider>
  )
}

/** Stand-ins for the bot's chat and Orca's browser pane beside it, under the pill. */
function Scene({ chatWidth = 300 }: { chatWidth?: number }): React.JSX.Element {
  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <div style={{ width: chatWidth }} className="flex shrink-0 flex-col border-r border-border">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            Marketing - X - Manager
          </div>
          <p className="p-4 text-sm">
            Hi, I&apos;m Marketing - X - Manager. What would you like me to work on first?
          </p>
          {/* The real composer's footprint: its box, the workspace footer row, then pb-4. */}
          <div className="mt-auto px-3 pt-2 pb-4">
            <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
              Ask anything, @ to mention…
              <div className="mt-2 flex items-center justify-between">
                <span className="grid size-6 place-items-center rounded-md border border-border">
                  +
                </span>
                <span className="grid size-6 place-items-center rounded-full bg-muted">↑</span>
              </div>
            </div>
            <div className="mt-1 flex h-5.5 items-center px-3 text-2xs text-muted-foreground">
              main · Folder
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-3 py-2.5 text-xs text-muted-foreground">
            github.com/organizations/stablyai/settings/installations
          </div>
          <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
            GitHub&apos;s install page (Orca browser pane)
          </div>
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center border-t border-border bg-sidebar px-3 text-2xs text-muted-foreground">
        Status bar
      </div>
      <Setup />
    </div>
  )
}

async function clickWhenShown(name: string): Promise<void> {
  for (let tries = 0; tries < 80; tries++) {
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

async function clickAddRepositories(): Promise<void> {
  for (let tries = 0; tries < 80; tries++) {
    const button = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Add repositories or an organization"]'
    )
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const before = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />
})

export const connect = defineFixture({
  width: 1100,
  setup: () => stubGitHub({ bot: triage, signedIn: false }),
  render: () => <Scene />
})

// Already on GitHub: how to ask, and the repositories on one line.
export const done = defineFixture({
  width: 1100,
  setup: () =>
    stubGitHub({
      bot: { ...triage, github: {} },
      with: [
        {
          installationId: '1',
          accountLogin: 'stablyai',
          repositories: ['orca', 'website', 'handbook', 'api', 'plugins', 'devex', 'widgets'].map(
            (name) => ({ fullName: `stablyai/${name}` })
          )
        }
      ]
    }),
  render: () => <Scene />
})

// GitHub's page opened in Orca's browser: setup minimized to the pill by itself.
export const inOrcaMinimized = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: () => clickAddRepositories()
})

// GitHub reported the save: the pill says what was added, before it expands.
export const inOrcaDone = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: async () => {
    await clickAddRepositories()
    installations = afterGitHub
    // The next poll (every 3 s) sees the change.
    await settle(3300)
  }
})

// Then the dialog opens again on the new repositories.
export const inOrcaExpanded = defineFixture({
  width: 1100,
  store: inOrcaStore,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: async () => {
    await clickAddRepositories()
    installations = afterGitHub
    await settle(5200)
  }
})

export const systemBrowserWaiting = defineFixture({
  width: 1100,
  setup: () => stubGitHub(),
  render: () => <Scene />,
  interact: () => clickAddRepositories()
})

// The redesign's review shots: the dialog alone at a fixed width, pinned into the frame.
const SHOT_STYLE = `
html[data-github-dialog-shot] [data-slot='dialog-overlay'] { display: none; }
html[data-github-dialog-shot] [data-slot='dialog-content'] {
  top: 16px; left: 16px; translate: none; transform: none; animation: none;
  width: var(--github-dialog-shot-width); max-width: var(--github-dialog-shot-width);
}`

const org = (id: string, login: string, names: string[]): ConnectorGitHubInstallation => ({
  installationId: id,
  accountLogin: login,
  repositories: names.map((name) => ({ fullName: `${login}/${name}` }))
})
const LONG_ORG = 'very-long-organization-name-incorporated-worldwide'
const LONG_REPO = 'marketing-website-v2-staging-preview-environment-for-the-launch'
const THIRTY = Array.from({ length: 30 }, (_, index) => `service-${index + 1}`)

const SHOT_REPOS = {
  one: [org('1', 'acme', ['widgets'])],
  seven: [
    org('1', 'acme', 'widgets marketing-website internal cloud plugins devex private'.split(' '))
  ],
  twoOrgs: [org('1', 'acme', ['widgets', 'cloud', 'devex']), org('2', 'carol-labs', ['press-kit'])],
  thirty: [org('1', 'acme', THIRTY)],
  long: [org('1', 'acme', [LONG_REPO, 'widgets']), org('2', LONG_ORG, ['handbook'])]
}

// Made-up people with no GitHub picture, so their initials show.
const TWO_PEOPLE = [
  { id: 'maya-chen', name: 'maya-chen', source: 'github' },
  { id: 'raj-patel', name: 'raj-patel', source: 'github' }
]

const LONG_LOGIN = 'a-very-long-github-username-for-testing-ellipsis'
// A worst case: a long bot name and login, a person with a long login, and a 30-repository org.
const WORST: Partial<Bot> = {
  name: 'Customer Support Escalations and Release Notes Writer',
  members: [{ id: 'long', name: 'someone-with-a-really-long-github-login-name', source: 'github' }]
}

function dialogShot(options: {
  width: 440 | 340
  repos: keyof typeof SHOT_REPOS
  people?: boolean
  bot?: Partial<Bot>
  login?: string
  /** Several linked GitHub logins: the header lists them all and drops Not you?. */
  logins?: string[]
  signedIn?: boolean
  expand?: string
  /** Then click "+ Add ↗": GitHub opens in the system browser and setup waits on it. */
  addRepositories?: boolean
}): ReturnType<typeof defineFixture> {
  return defineFixture({
    width: options.width + 32,
    setup: () => {
      stubGitHub({
        bot: { ...marketing, members: options.people ? TWO_PEOPLE : [], ...options.bot },
        with: SHOT_REPOS[options.repos],
        signedIn: options.signedIn
      })
      if (options.login && account) {
        account = { ...account, login: options.login }
      }
      if (options.logins) {
        accounts = options.logins.map((login, index) => ({
          userId: String(42 + index),
          login,
          installations: installations.map((entry) => entry.installationId),
          defaultBotId: null
        }))
        account = { userId: '42', login: options.logins[0] }
      }
      if (!document.getElementById('github-dialog-shot')) {
        const style = document.createElement('style')
        style.id = 'github-dialog-shot'
        style.textContent = SHOT_STYLE
        document.head.append(style)
      }
      document.documentElement.dataset.githubDialogShot = ''
      document.documentElement.style.setProperty('--github-dialog-shot-width', `${options.width}px`)
    },
    render: () => <Setup />,
    interact: async (frame) => {
      await settle(400)
      if (options.expand) {
        await clickWhenShown(options.expand)
      }
      if (options.addRepositories) {
        await clickAddRepositories()
      }
      await settle(200)
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
      if (dialog) {
        frame.style.height = `${dialog.offsetHeight + 32}px`
      }
    }
  })
}

export const shotOneRepo = dialogShot({ width: 440, repos: 'one' })
export const shotOneRepoNarrow = dialogShot({ width: 340, repos: 'one' })
export const shotSeven = dialogShot({ width: 440, repos: 'seven' })
export const shotSevenNarrow = dialogShot({ width: 340, repos: 'seven' })
export const shotSevenOpen = dialogShot({ width: 440, repos: 'seven', expand: 'acme7 repos' })
export const shotSevenOpenNarrow = dialogShot({ width: 340, repos: 'seven', expand: 'acme7 repos' })
export const shotTwoOrgs = dialogShot({ width: 440, repos: 'twoOrgs' })
export const shotTwoOrgsNarrow = dialogShot({ width: 340, repos: 'twoOrgs' })
const LONG_SHOT = { repos: 'long', expand: 'acme2 repos' } as const
export const shotLongNames = dialogShot({ width: 440, ...LONG_SHOT })
export const shotLongNamesNarrow = dialogShot({ width: 340, ...LONG_SHOT })
export const shotPeople = dialogShot({ width: 440, repos: 'twoOrgs', people: true })
export const shotPeopleNarrow = dialogShot({ width: 340, repos: 'twoOrgs', people: true })
const WORST_SHOT = {
  repos: 'thirty',
  bot: WORST,
  login: LONG_LOGIN,
  expand: 'acme30 repos'
} as const
export const shotWorst = dialogShot({ width: 440, ...WORST_SHOT })
export const shotWorstNarrow = dialogShot({ width: 340, ...WORST_SHOT })
export const shotDone = dialogShot({ width: 440, repos: 'seven', bot: { github: {} } })
export const shotDoneNarrow = dialogShot({ width: 340, repos: 'seven', bot: { github: {} } })
// Waiting on GitHub in the system browser: the corner button minimizes (dash) instead of ending setup.
export const shotWaiting = dialogShot({ width: 440, repos: 'twoOrgs', addRepositories: true })
export const shotWaitingNarrow = dialogShot({ width: 340, repos: 'twoOrgs', addRepositories: true })
export const shotConnect = dialogShot({ width: 340, repos: 'one', signedIn: false })
// Three linked GitHub logins, one 48 characters long: one header line, ellipsized, × stays put.
const THREE_LOGINS = ['carol-gh', LONG_LOGIN, 'carol-work'] as const
export const shotLogins = dialogShot({ width: 440, repos: 'twoOrgs', logins: [...THREE_LOGINS] })
export const shotLoginsNarrow = dialogShot({
  width: 340,
  repos: 'twoOrgs',
  logins: [...THREE_LOGINS]
})
