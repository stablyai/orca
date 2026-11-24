// Shared stubs for the GitHub setup dialog's fixtures: a fake GitHub state, the mounted setup, clicks.
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

export const marketing: Bot = {
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

export const stablyai: ConnectorGitHubInstallation = {
  installationId: '1',
  accountLogin: 'stablyai',
  repositories: [
    { fullName: 'stablyai/orca' },
    { fullName: 'stablyai/website' },
    { fullName: 'acme/widgets' }
  ]
}

let installations: ConnectorGitHubInstallation[] = [stablyai]
let account: { userId: string; login: string } | null = { userId: '42', login: 'carol-gh' }
/** Several GitHub users linked to this Orca account; unset means only `account`. */
let accounts: ConnectorGitHubLinkedAccount[] | undefined
/** GitHub's state read fails, e.g. a dropped connection while an install is followed. */
let stateFails = false
/** GitHub's state read never answers: setup stays on Checking GitHub…. */
let stateHangs = false
let stateReads = 0
let shownBot = marketing
const neverReturns = (): Promise<never> => new Promise(() => {})

export function stubGitHub(
  options: {
    bot?: Bot
    signedIn?: boolean
    with?: ConnectorGitHubInstallation[]
    /** The signed-in login, in place of carol-gh. */
    login?: string
    /** Several linked GitHub logins: the header lists them all and drops Not you?. */
    logins?: string[]
    /** GitHub's state never answers (Checking) or fails with nothing pending (failed). */
    state?: 'hangs' | 'fails'
  } = {}
): void {
  delete document.documentElement.dataset.githubDialogShot
  installations = options.with ?? [stablyai]
  account = options.signedIn === false ? null : { userId: '42', login: 'carol-gh' }
  accounts = options.logins?.map((login, index) => ({
    userId: String(42 + index),
    login,
    installations: installations.map((entry) => entry.installationId),
    defaultBotId: null
  }))
  const login = options.logins?.[0] ?? options.login
  if (account && login) {
    account = { ...account, login }
  }
  stateFails = options.state === 'fails'
  stateHangs = options.state === 'hangs'
  stateReads = 0
  shownBot = options.bot ?? marketing
  stopAwaitingGitHub('local')
  cancelConnectorConnect('local', 'github')
  resetGitHubInstallForTests()
  publishBots([shownBot])
  openGitHubInstall(shownBot)
  Reflect.set(window.api, 'botGitHub', {
    state: async () => {
      stateReads += 1
      if (stateHangs) {
        return neverReturns()
      }
      return stateFails
        ? { ok: false, error: 'fixture_unreachable' }
        : {
            ok: true,
            value: {
              installUrl: 'https://github.com/apps/orca-ide/installations/new',
              account,
              ...(accounts ? { accounts } : {}),
              installations,
              defaultBotId: null
            }
          }
    },
    users: async () => ({ ok: false, error: 'fixture' }),
    connect: neverReturns,
    cancelConnect: async () => undefined,
    unlink: neverReturns
  })
  Reflect.set(window.api, 'shell', { ...window.api.shell, openUrl: async () => undefined })
  withBotConnectorRuntime(window.api)
  // For interaction checks: GitHub recovers or saves while the setup is minimized.
  Reflect.set(window, '__githubSetupFixture', {
    setStateFails: (fails: boolean) => {
      stateFails = fails
    },
    addRepository: (fullName: string) => {
      const [first, ...rest] = installations
      installations = [
        { ...first, repositories: [...(first.repositories ?? []), { fullName }] },
        ...rest
      ]
    },
    stateReads: () => stateReads
  })
}

const WORKSPACE = makeWorktree({ id: 'repo-1::/marketing', repoId: 'repo-1', path: '/marketing' })
// Link setting = open in Orca, in the bot's workspace.
export const inOrcaStore = {
  settings: { ...getDefaultSettings('/home/fixture'), openLinksInApp: true },
  activeWorktreeId: WORKSPACE.id,
  repos: [makeRepo()],
  worktreesByRepo: { 'repo-1': [WORKSPACE] }
}

/** The setup as the app mounts it: the dialog, or minimized to the pill. */
export function Setup(): React.JSX.Element | null {
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

export async function clickWhenShown(name: string): Promise<void> {
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

export async function clickAddRepositories(): Promise<void> {
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

export const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** A later read of GitHub's state fails, e.g. the connection drops while an install is followed. */
export function failGitHubReads(): void {
  stateFails = true
}

/** GitHub's installs from now on, e.g. after its install page saved. */
export function setGitHubInstallations(next: ConnectorGitHubInstallation[]): void {
  installations = next
}
