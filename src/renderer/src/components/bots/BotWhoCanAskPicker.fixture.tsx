import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGitHubPeople } from '../../../../shared/connector-bot-github-contract'
import type { BotWhoCanAskService } from './BotWhoCanAskList'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'
import { gitHubWhoCanAskFound } from './github/github-who-can-ask-found'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Issue Triager', members: [] } as unknown as Bot
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the English default, as i18next answers with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, string>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => values?.[name] ?? '')) as never

// Fictional people; ids are GitHub-shaped so the avatar falls back to initials offline.
const team: BotGitHubPeople['members'] = [
  { id: '1000001', name: 'mayaokafor', handle: 'Maya Okafor' },
  { id: '1000002', name: 'dev-lindqvist', handle: 'Devon Lindqvist' },
  { id: '1000003', name: 'rpatel-gh', handle: 'Ravi Patel' },
  { id: '1000004', name: 'sam-yu', handle: 'Sam Yu' },
  {
    id: '1000005',
    name: 'alexandra-konstantinopoulou-dev',
    handle: 'Alexandra Konstantinopoulou-Whitfield'
  }
]
// Exact usernames that belong to someone the repos' search did not find.
const strangers: Record<string, string> = { maya: '1000009', jordan: '1000010' }
const exactHit = (query: string) => {
  const id = strangers[query.toLowerCase()]
  return id ? [{ id, name: query }] : []
}
const teamMatching = (query: string) =>
  team.filter((person) =>
    `${person.name} ${person.handle ?? ''}`.toLowerCase().includes(query.toLowerCase())
  )
const isLogin = (query: string) => /^[A-Za-z0-9-]+$/.test(query)

type Host = (query: string) => BotGitHubPeople

// What the host answers in each situation, read by the real mapper.
const searched =
  (local: 'full' | 'limited', more: { narrowable?: boolean } = {}): Host =>
  (query) => ({
    members: [
      ...teamMatching(query).map((person) => ({ ...person, found: 'scope' as const })),
      ...exactHit(query).map((person) => ({
        ...person,
        found: local === 'full' ? ('outside' as const) : ('exact' as const)
      }))
    ],
    complete: local === 'full',
    coverage: { local, exact: isLogin(query) ? 'searched' : 'skipped', ...more }
  })
const ghUnavailable: Host = (query) => ({
  members: exactHit(query).map((person) => ({ ...person, found: 'exact' as const })),
  complete: false,
  coverage: { local: 'unavailable', exact: isLogin(query) ? 'searched' : 'skipped' }
})

const make = (host: Host): BotWhoCanAskService => ({
  listed: () => [],
  stamp: { source: 'github' },
  max: 50,
  search: async (query) => ({
    ok: true,
    value: gitHubWhoCanAskFound(
      host(query),
      { query, ownerLogin: 'owner', withOrganizations: false },
      t
    )
  }),
  errorMessage: (code) => code,
  searchPlaceholder: 'Search by name or username',
  peopleHeading: 'People on GitHub',
  scopedHeading: 'Found in your repos',
  outsideHeading: 'Elsewhere on GitHub',
  outsideTag: 'Not found in your repos',
  noMatch: (query) => ({
    title: `No one found for “${query}”`,
    detail: 'Searched your repos and exact usernames.'
  }),
  idleHint: { title: 'Find people', detail: 'Teammates by name, others by exact username.' },
  ownerId: null,
  ownerName: null,
  kind: 'github',
  connector: 'GitHub',
  workspace: null,
  outsiders: null,
  notYet: ''
})

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
const pickerOf = (host: Host) => () => (
  <div className="w-80 rounded-md border border-border bg-popover">
    <BotWhoCanAskPicker bot={bot} service={make(host)} owner="You" onPicked={() => {}} />
  </div>
)
const searching =
  (query: string) =>
  async (frame: HTMLElement): Promise<void> => {
    await settle()
    type(frame, query)
    await settle()
  }
const full = searched('full')

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
  render: pickerOf(ghUnavailable),
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
  render: pickerOf(ghUnavailable),
  interact: searching('jordan')
})

/** gh couldn't search and the name isn't a username: nothing was searched, and it says so. */
export const ghUnavailableNothingSearched = defineFixture({
  width: 340,
  render: pickerOf(ghUnavailable),
  interact: searching('neil par')
})

/** A caps-hit search: results, with advice that typing more narrows them. */
export const capsHit = defineFixture({
  width: 340,
  render: pickerOf(searched('limited', { narrowable: true })),
  interact: searching('a')
})

/** Part of the scope wasn't searched (a cut roster): limited, without the typing advice. */
export const scopeCut = defineFixture({
  width: 340,
  render: pickerOf(searched('limited')),
  interact: searching('maya')
})
