import { defineFixture } from '../../../component-fixtures/component-fixture'
import { readGitHubAwait } from '@/lib/bot-github-state'
import { expandGitHubInstall } from '@/lib/bot-github-install-record'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import {
  Setup,
  clickAddRepositories,
  clickWhenShown,
  failGitHubReads,
  inOrcaStore,
  marketing,
  settle,
  stubGitHub
} from './github-setup-dialog.test-fixture'

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
  long: [org('1', 'acme', [LONG_REPO, 'widgets']), org('2', LONG_ORG, ['handbook'])],
  // Every scope label: several repos, one repo, and a whole account.
  scope: [
    org('1', 'acme', ['widgets', 'cloud', 'devex']),
    org('2', 'carol-labs', ['press-kit']),
    { installationId: '3', accountLogin: 'carol-org', repositories: null }
  ]
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
  /** GitHub opens in Orca's browser, a state read then fails, and the dialog opens again. */
  failedWhilePending?: boolean
  /** GitHub's state never answers (Checking) or fails with nothing pending (failed). */
  state?: 'hangs' | 'fails'
}): ReturnType<typeof defineFixture> {
  return defineFixture({
    ...(options.failedWhilePending ? { store: inOrcaStore } : {}),
    width: options.width + 32,
    setup: () => {
      stubGitHub({
        bot: { ...marketing, members: options.people ? TWO_PEOPLE : [], ...options.bot },
        with: SHOT_REPOS[options.repos],
        signedIn: options.signedIn,
        login: options.login,
        logins: options.logins,
        state: options.state
      })
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
      if (options.failedWhilePending) {
        await clickAddRepositories()
        failGitHubReads()
        // The running poll's next read fails and ends it; the record then holds a slower refollow.
        for (let tries = 0; tries < 60 && readGitHubAwait('local') === 'checking'; tries++) {
          await settle(200)
        }
        expandGitHubInstall()
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
export const shotScopeLabels = dialogShot({ width: 440, repos: 'scope' })
export const shotConnect = dialogShot({ width: 340, repos: 'one', signedIn: false })
// Three linked GitHub logins, one 48 characters long: one header line, ellipsized, × stays put.
const THREE_LOGINS = ['carol-gh', LONG_LOGIN, 'carol-work'] as const
export const shotLogins = dialogShot({ width: 440, repos: 'twoOrgs', logins: [...THREE_LOGINS] })
// An install trip in Orca's browser is still followed when a read fails: the corner stays Minimize.
export const shotFailedPendingNarrow = dialogShot({
  width: 340,
  repos: 'twoOrgs',
  failedWhilePending: true
})
// A long name with no spaces in the header's status line, while checking and after a failed read.
const UNBROKEN: Partial<Bot> = { name: 'CustomerSupportEscalationsAndReleaseNotesWriterBot' }
export const shotCheckingLongNameNarrow = dialogShot({
  width: 340,
  repos: 'one',
  bot: UNBROKEN,
  state: 'hangs'
})
export const shotFailedLongNameNarrow = dialogShot({
  width: 340,
  repos: 'one',
  bot: UNBROKEN,
  state: 'fails'
})
export const shotLoginsNarrow = dialogShot({
  width: 340,
  repos: 'twoOrgs',
  logins: [...THREE_LOGINS]
})
