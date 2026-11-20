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
const readRoster = (more: Partial<Extract<BotGitHubRoster, { status: 'read' }>> = {}) =>
  ({
    status: 'read',
    people: team,
    from: { repositories: true, organizations: false },
    complete: true,
    cut: false,
    ...more
  }) satisfies BotGitHubRoster

type Roster = BotGitHubRoster
const scope = { repositories: ['acme/web'], owners: [], more: false }

const make = (roster: Roster): BotWhoCanAskService => {
  const begin = () =>
    gitHubWhoCanAskSession(
      { people: async () => ({ ok: true, value: roster }), users },
      { scope, ownerLogin: 'owner', hostName: null, t }
    )
  return {
    listed: () => [],
    stamp: { source: 'github' },
    max: 50,
    search: (query) => begin()(query),
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
const pickerOf = (roster: Roster) => () => (
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
const unavailable: Roster = { status: 'unavailable' }

/** An empty search suggests the people found in the connected repositories. */
export const suggestions = defineFixture({ width: 340, render: pickerOf(full), interact: settle })

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
  render: pickerOf(readRoster({ cut: true })),
  interact: searching('a')
})

/** A repo couldn't be read: the exact match is tagged, and the note says so. */
export const partlyRead = defineFixture({
  width: 340,
  render: pickerOf(readRoster({ complete: false })),
  interact: searching('maya')
})
