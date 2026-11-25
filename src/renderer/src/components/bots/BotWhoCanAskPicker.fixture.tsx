import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type {
  BotGitHubRoster,
  ConnectorGitHubUsersResponse
} from '../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../shared/connector-bot-slack-contract'
import type { BotWhoCanAskService } from './BotWhoCanAskList'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'
import { gitHubWhoCanAskSession } from './github/github-who-can-ask-session'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Issue Triager', members: [] } as unknown as Bot
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the English default, as i18next answers with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))) as never

// Fictional people; ids are GitHub-shaped so the avatar falls back to initials offline.
const team = [
  { id: '1000001', login: 'mayaokafor', name: 'Maya Okafor' },
  { id: '1000002', login: 'dev-lindqvist', name: 'Devon Lindqvist' },
  { id: '1000003', login: 'rpatel-gh', name: 'Ravi Patel' },
  { id: '1000004', login: 'sam-yu', name: 'Sam Yu' },
  {
    id: '1000005',
    login: 'alexandra-konstantinopoulou-dev',
    name: 'Alexandra Konstantinopoulou-Whitfield'
  }
]
// Exact usernames that belong to someone outside the roster.
const strangers: Record<string, string> = { maya: '1000009', jordan: '1000010' }
const users = async ({
  query
}: {
  query: string
}): Promise<BotSlackResult<ConnectorGitHubUsersResponse>> => {
  const id = strangers[query.toLowerCase()]
  return { ok: true, value: { members: id ? [{ id, name: query }] : [], complete: true } }
}
const scope = { repositories: ['acme/web'], owners: [], more: false }
const readRoster = (more: Partial<Extract<BotGitHubRoster, { status: 'read' }>> = {}) =>
  ({
    status: 'read',
    people: team,
    from: { repositories: true, organizations: false },
    complete: true,
    omitted: false,
    cut: { people: false, members: false, repositories: false },
    // 2:05 PM local time on a fixed day, so the shot is stable.
    readAt: new Date(2026, 10, 19, 14, 5).getTime(),
    reused: false,
    readFor: { scope, owner: 'owner' },
    ...more
  }) satisfies BotGitHubRoster

type Roster = BotGitHubRoster

// 'loading': a roster that never lands, to show the picker while it is on its way.
const make = (roster: Roster | 'loading'): BotWhoCanAskService => {
  const begin = () =>
    gitHubWhoCanAskSession(
      {
        people: () =>
          roster === 'loading'
            ? new Promise<never>(() => {})
            : Promise.resolve({ ok: true as const, value: roster }),
        users
      },
      { scope, ownerLogin: 'owner', producer: 'local', t }
    )
  return {
    listed: () => [],
    stamp: { source: 'github' },
    max: 50,
    search: (query) => begin().search(query),
    begin,
    errorMessage: (code) => code,
    searchPlaceholder: 'Search by name or username',
    peopleHeading: 'People on GitHub',
    outsideHeading: 'Elsewhere on GitHub',
    noMatch: (query) => ({ title: `No one found for “${query}”`, detail: '' }),
    idleHint: { title: 'Find people', detail: 'Teammates by name, others by exact username.' },
    ownerId: null,
    ownerName: null,
    kind: 'github',
    connector: 'GitHub',
    workspace: null,
    outsiders: null,
    notYet: ''
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))

function type(frame: HTMLElement, value: string): void {
  const input = frame.querySelector<HTMLInputElement>('input')
  const setValue =
    input && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (input && setValue) {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function tick(frame: HTMLElement, login: string): void {
  const row = [...frame.querySelectorAll<HTMLElement>('[cmdk-item]')].find((item) =>
    item.textContent?.includes(login)
  )
  row?.click()
}

// The Add popover is a fixed w-80 (320px) everywhere, so that is also its narrowest.
const pickerOf = (roster: Roster | 'loading') => () => (
  <div className="w-80 rounded-md border border-border bg-popover">
    <BotWhoCanAskPicker bot={bot} service={make(roster)} owner="You" onPicked={() => {}} />
  </div>
)
const searching =
  (query: string) =>
  async (frame: HTMLElement): Promise<void> => {
    await settle()
    type(frame, query)
    await settle()
  }
const full = readRoster()
const unavailable: Roster = { status: 'unavailable', spent: true }

/** An empty search suggests the people found in the connected repositories. */
export const suggestions = defineFixture({ width: 340, render: pickerOf(full), interact: settle })

export const exactOnly = defineFixture({
  width: 340,
  render: pickerOf({ status: 'exact-only' }),
  interact: settle
})

/** A first name finds the teammate by real name; a stranger with that exact username sits apart. */
export const firstName = defineFixture({
  width: 340,
  render: pickerOf(full),
  interact: searching('maya')
})

/** Someone ticked stays counted in the footer but is not listed under a search they don't match. */
export const tickedThenSearch = defineFixture({
  width: 340,
  render: pickerOf(full),
  interact: async (frame) => {
    await settle()
    tick(frame, 'sam-yu')
    type(frame, 'ravi')
    await settle()
  }
})

/** A name nobody in the repositories has: only the stranger with that exact username, tagged. */
export const strangerOnly = defineFixture({
  width: 340,
  render: pickerOf(full),
  interact: searching('jordan')
})

/** No one found, at the popover's fixed (and narrowest) width. */
export const noMatchNarrow = defineFixture({
  width: 340,
  render: pickerOf(full),
  interact: searching('zzqx')
})

/** Nobody to suggest: the empty box asks for a name. */
export const idleHint = defineFixture({
  width: 340,
  render: pickerOf(unavailable),
  interact: settle
})

/** Someone ticked shows under Selected while the search still matches them. */
export const tickedStillMatching = defineFixture({
  width: 340,
  render: pickerOf(full),
  interact: async (frame) => {
    await searching('jordan')(frame)
    tick(frame, 'jordan')
    type(frame, 'jor')
    await settle()
  }
})

/** A long username and real name truncate at the popover's fixed width. */
export const longNameNarrow = defineFixture({
  width: 340,
  render: pickerOf(full),
  interact: searching('alex')
})

/** gh couldn't search: the exact match is tagged, not called an outsider, and the note says why. */
export const ghUnavailableExact = defineFixture({
  width: 340,
  render: pickerOf(unavailable),
  interact: searching('jordan')
})

/** gh couldn't search and the name isn't a username: nothing was searched, and it says so. */
export const ghUnavailableNothingSearched = defineFixture({
  width: 340,
  render: pickerOf(unavailable),
  interact: searching('neil par')
})

/** A repo past the first 100 people: the list says it shows only those. */
export const firstHundred = defineFixture({
  width: 340,
  render: pickerOf(readRoster({ cut: { people: true, members: false, repositories: false } })),
  interact: searching('a')
})

/** A repo couldn't be read: the exact match is tagged, and the note says so. */
export const partlyRead = defineFixture({
  width: 340,
  render: pickerOf(readRoster({ complete: false })),
  interact: searching('maya')
})

/** The roster still on its way, a name that isn't a username: not "no one found". */
export const rosterLoading = defineFixture({
  width: 340,
  render: pickerOf('loading'),
  interact: async (frame) => {
    await searching('neil par')(frame)
    await new Promise((resolve) => setTimeout(resolve, 1_600))
  }
})

/** The roster still on its way; the exact match shows now, tagged. */
export const rosterLoadingExact = defineFixture({
  width: 340,
  render: pickerOf('loading'),
  interact: async (frame) => {
    await searching('jordan')(frame)
    await new Promise((resolve) => setTimeout(resolve, 1_600))
  }
})

/** A list read earlier this app run, reused: says when, and how to refresh it. */
export const reusedList = defineFixture({
  width: 340,
  render: pickerOf(readRoster({ reused: true })),
  interact: searching('maya')
})

/** A list read on an earlier day of the same app run: the note gives the date. */
export const reusedListOlder = defineFixture({
  width: 340,
  render: pickerOf(readRoster({ reused: true, readAt: new Date(2026, 10, 10, 9, 30).getTime() })),
  interact: searching('maya')
})

/** A list read earlier for other repos (or another account): history, claiming nothing current. */
export const historicalList = defineFixture({
  width: 340,
  render: pickerOf(
    readRoster({
      reused: true,
      readAt: new Date(2026, 10, 10, 9, 30).getTime(),
      readFor: { scope: { repositories: ['acme/old'], owners: [], more: false }, owner: 'owner' }
    })
  ),
  interact: searching('maya')
})

/** An org past its first 100 members. */
export const orgCut = defineFixture({
  width: 340,
  render: pickerOf(
    readRoster({
      from: { repositories: false, organizations: true },
      cut: { people: false, members: true, repositories: false }
    })
  ),
  interact: searching('a')
})

/** Several kinds of read stopped at their size at once. */
export const mixedCut = defineFixture({
  width: 340,
  render: pickerOf(
    readRoster({
      from: { repositories: true, organizations: true },
      cut: { people: true, members: true, repositories: false }
    })
  ),
  interact: searching('a')
})

// The exact lookup fails until asked again.
let usersFail = true
const flakyUsers = async ({
  query
}: {
  query: string
}): Promise<BotSlackResult<ConnectorGitHubUsersResponse>> =>
  usersFail ? { ok: false, error: 'network' } : users({ query })

/** A failed username check: Try again in place, rows and picks kept. */
export const exactFailedRetry = defineFixture({
  width: 340,
  render: () => (
    <div className="w-80 rounded-md border border-border bg-popover">
      <BotWhoCanAskPicker
        bot={bot}
        service={{
          ...make(readRoster()),
          begin: () =>
            gitHubWhoCanAskSession(
              { people: async () => ({ ok: true, value: readRoster() }), users: flakyUsers },
              { scope, ownerLogin: 'owner', producer: 'local', t }
            )
        }}
        owner="You"
        onPicked={() => {}}
      />
    </div>
  ),
  interact: async (frame) => {
    usersFail = true
    await searching('maya')(frame)
  }
})

/** The scope held nothing readable: nothing was spent, and no gh advice. */
export const noReadable = defineFixture({
  width: 340,
  render: pickerOf({ status: 'unavailable', spent: false }),
  interact: searching('neil par')
})

const unreachedPicker = () => (
  <div className="w-80 rounded-md border border-border bg-popover">
    <BotWhoCanAskPicker
      bot={bot}
      service={{
        ...make(readRoster()),
        begin: () =>
          gitHubWhoCanAskSession(
            { people: async () => ({ ok: false, error: 'network' }), users },
            { scope, ownerLogin: 'owner', producer: 'local', t }
          )
      }}
      owner="You"
      onPicked={() => {}}
    />
  </div>
)

/** The host never answered the list request: Try again in place, the exact row and query kept. */
export const listUnreached = defineFixture({
  width: 340,
  render: unreachedPicker,
  interact: searching('maya')
})

/** The same, before anything is typed: the hint keeps its Try again. */
export const listUnreachedIdle = defineFixture({
  width: 340,
  render: unreachedPicker,
  interact: settle
})

/** The list request and the username check both failed: one in-place Try again covers both. */
export const listAndExactFailed = defineFixture({
  width: 340,
  render: () => (
    <div className="w-80 rounded-md border border-border bg-popover">
      <BotWhoCanAskPicker
        bot={bot}
        service={{
          ...make(readRoster()),
          begin: () =>
            gitHubWhoCanAskSession(
              {
                people: async () => ({ ok: false, error: 'network' }),
                users: async () => ({ ok: false, error: 'network' })
              },
              { scope, ownerLogin: 'owner', producer: 'local', t }
            )
        }}
        owner="You"
        onPicked={() => {}}
      />
    </div>
  ),
  interact: searching('maya')
})
