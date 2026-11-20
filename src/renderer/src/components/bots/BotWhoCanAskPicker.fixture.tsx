import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type { BotWhoCanAskFound, BotWhoCanAskService } from './BotWhoCanAskList'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Issue Triager', members: [] } as unknown as Bot

// Fictional people; ids are GitHub-shaped so the avatar falls back to initials offline.
const team: BotWhoCanAskFound['members'] = [
  { id: '1000001', name: 'mayaokafor', handle: 'Maya Okafor', group: 'scoped' },
  { id: '1000002', name: 'dev-lindqvist', handle: 'Devon Lindqvist', group: 'scoped' },
  { id: '1000003', name: 'rpatel-gh', handle: 'Ravi Patel', group: 'scoped' },
  { id: '1000004', name: 'sam-yu', handle: 'Sam Yu', group: 'scoped' },
  {
    id: '1000005',
    name: 'alexandra-konstantinopoulou-dev',
    handle: 'Alexandra Konstantinopoulou-Whitfield',
    group: 'scoped'
  }
]
// Exact usernames that belong to someone outside the connected repositories.
const strangers: Record<string, BotWhoCanAskFound['members'][number]> = {
  maya: { id: '1000009', name: 'maya', group: 'outside' as const },
  jordan: { id: '1000010', name: 'jordan', group: 'outside' as const }
}

function find(query: string): BotWhoCanAskFound['members'] {
  const needle = query.toLowerCase()
  const mine = team.filter((person) =>
    `${person.name} ${person.handle ?? ''}`.toLowerCase().includes(needle)
  )
  const stranger = strangers[needle]
  return stranger ? [...mine, stranger] : mine
}

const make = (
  search: (query: string) => BotWhoCanAskFound['members'],
  note?: string
): BotWhoCanAskService => ({
  listed: () => [],
  stamp: { source: 'github' },
  max: 50,
  search: async (query) => ({
    ok: true,
    value: { members: search(query), complete: true, ...(note ? { note } : {}) }
  }),
  errorMessage: (code) => code,
  searchPlaceholder: 'Search by name or username',
  peopleHeading: 'People on GitHub',
  scopedHeading: 'People in your repositories',
  outsideHeading: 'Elsewhere on GitHub',
  outsideTag: 'Not in your repos',
  noMatch: (query) => ({
    title: `No one found for “${query}”`,
    detail: 'Checked your repos and exact GitHub usernames.'
  }),
  idleHint: {
    title: 'Type a name or GitHub username',
    detail: 'Find teammates by name, or anyone by exact GitHub username.'
  },
  ownerId: null,
  ownerName: null,
  kind: 'github',
  connector: 'GitHub',
  workspace: null,
  outsiders: null,
  notYet: ''
})
const service = make(find)
// gh can't answer (or no repositories are connected): only the exact-username lookup is left.
const exactOnly = make((query) => {
  const stranger = strangers[query.toLowerCase()]
  return stranger ? [stranger] : []
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
const pickerOf = (of: BotWhoCanAskService) => () => (
  <div className="w-80 rounded-md border border-border bg-popover">
    <BotWhoCanAskPicker bot={bot} service={of} owner="You" onPicked={() => {}} />
  </div>
)
const picker = pickerOf(service)
const searching =
  (query: string) =>
  async (frame: HTMLElement): Promise<void> => {
    await settle()
    type(frame, query)
    await settle()
  }

/** An empty search suggests the people of the connected repositories. */
export const suggestions = defineFixture({ width: 340, render: picker, interact: settle })

/** A first name finds the teammate by real name; a stranger with that exact username sits apart. */
export const firstName = defineFixture({
  width: 340,
  render: picker,
  interact: async (frame) => {
    await settle()
    type(frame, 'maya')
    await settle()
  }
})

/** Someone ticked stays counted in the footer but is not listed under a search they don't match. */
export const tickedThenSearch = defineFixture({
  width: 340,
  render: picker,
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
  render: picker,
  interact: searching('jordan')
})

/** No one found, at the popover's fixed (and narrowest) width. */
export const noMatchNarrow = defineFixture({
  width: 340,
  render: picker,
  interact: searching('zzqx')
})

/** Nobody to suggest (gh unavailable or no repositories): the empty box asks for a name. */
export const idleHint = defineFixture({
  width: 340,
  render: pickerOf(exactOnly),
  interact: settle
})

/** Someone ticked shows under Selected while the search still matches them. */
export const tickedStillMatching = defineFixture({
  width: 340,
  render: pickerOf(exactOnly),
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
  render: picker,
  interact: searching('alex')
})

// gh missing or signed out on the bot's computer: only the exact-username lookup ran.
const unavailable = make((query) => {
  const stranger = strangers[query.toLowerCase()]
  return stranger ? [{ id: stranger.id, name: stranger.name }] : []
}, 'Couldn’t search your repos from this computer, so only exact GitHub usernames were checked.')

/** gh couldn't search: an exact match is not called an outsider, and the note says why. */
export const ghUnavailable = defineFixture({
  width: 340,
  render: pickerOf(unavailable),
  interact: searching('jordan')
})

/** gh couldn't search and the name isn't an exact username: no false "no one exists". */
export const ghUnavailableNoMatch = defineFixture({
  width: 340,
  render: pickerOf(unavailable),
  interact: searching('neil par')
})
