// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, BotMember } from '../../../../shared/bot-types'
import type { BotWhoCanAskFound, BotWhoCanAskService } from './BotWhoCanAskList'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Atlas', members: [] } as unknown as Bot

const teammates: BotWhoCanAskFound['members'] = [
  { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', group: 'scoped' },
  { id: '5', name: 'Jinwoo-H', handle: 'Jinwoo Hong', group: 'scoped' }
]

function service(
  found: (query: string) => BotWhoCanAskFound['members'],
  note?: string
): BotWhoCanAskService {
  return {
    listed: () => [],
    stamp: { source: 'github' },
    max: 50,
    search: vi.fn(async (query: string) => ({
      ok: true as const,
      value: { members: found(query), complete: true, ...(note ? { note } : {}) }
    })),
    errorMessage: (code) => code,
    searchPlaceholder: 'Search by name or username',
    peopleHeading: 'People on GitHub',
    scopedHeading: 'People in your repositories',
    outsideHeading: 'Elsewhere on GitHub',
    outsideTag: 'Not in your repos',
    noMatch: (query) => ({ title: `No one found for ${query}`, detail: '' }),
    idleHint: { title: 'Find people', detail: '' },
    ownerId: null,
    ownerName: null,
    kind: 'github',
    connector: 'GitHub',
    workspace: null,
    outsiders: null,
    notYet: ''
  }
}

const matching = (query: string) =>
  teammates.filter(
    (person) =>
      `${person.name} ${person.handle}`.toLowerCase().includes(query.toLowerCase()) || query === ''
  )

afterEach(cleanup)

describe('Who can ask › Add on GitHub', () => {
  it('suggests teammates on an empty search instead of asking for an exact username', async () => {
    render(
      <BotWhoCanAskPicker bot={bot} service={service(matching)} owner="You" onPicked={vi.fn()} />
    )
    expect(await screen.findByText('People in your repositories')).toBeTruthy()
    expect(screen.getByText('Brennan Benson')).toBeTruthy()
    expect(screen.queryByText('Find people')).toBeNull()
  })

  it('keeps a stranger with that exact username apart from teammates', async () => {
    const found = (query: string) =>
      query === 'brennan'
        ? [teammates[0], { id: '9', name: 'brennan', group: 'outside' as const }]
        : matching(query)
    render(<BotWhoCanAskPicker bot={bot} service={service(found)} owner="You" onPicked={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'brennan' }
    })
    const elsewhere = await screen.findByText('Elsewhere on GitHub')
    const group = elsewhere.closest('[cmdk-group]')
    expect(group?.textContent).toContain('brennan')
    expect(group?.textContent).not.toContain('brennanb2025')
  })

  it('does not list a ticked person under a search they do not match', async () => {
    render(
      <BotWhoCanAskPicker bot={bot} service={service(matching)} owner="You" onPicked={vi.fn()} />
    )
    fireEvent.click(await screen.findByText('Jinwoo-H'))
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'brennan' }
    })
    await screen.findByText('brennanb2025')
    expect(screen.queryByText('Jinwoo-H')).toBeNull()
    expect(screen.queryByText('Selected')).toBeNull()
    expect(screen.getByText('1 selected')).toBeTruthy()

    // Searched by their real name, they come back, still ticked.
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'hong' }
    })
    expect(await screen.findByText('Jinwoo-H')).toBeTruthy()
  })

  it('lists people with no known source under the neutral heading, never as teammates', async () => {
    // An older host answers bare members: nothing says they are in the owner's repositories.
    const legacy = () => [{ id: '9', name: 'brennan' }]
    render(
      <BotWhoCanAskPicker bot={bot} service={service(legacy)} owner="You" onPicked={vi.fn()} />
    )
    const heading = await screen.findByText('People on GitHub')
    expect(heading.closest('[cmdk-group]')?.textContent).toContain('brennan')
    expect(screen.queryByText('People in your repositories')).toBeNull()
    expect(screen.queryByText('Not in your repos')).toBeNull()
  })

  it('says what the search could not cover instead of claiming no one exists', async () => {
    const note = 'Repos unavailable here. Exact usernames only.'
    render(
      <BotWhoCanAskPicker
        bot={bot}
        service={service(() => [], note)}
        owner="You"
        onPicked={vi.fn()}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('Search by name or username'), {
      target: { value: 'neil par' }
    })
    expect(await screen.findByText('No one found for neil par')).toBeTruthy()
    expect(screen.getByText(note)).toBeTruthy()
  })

  it('does not say no one was found while a ticked person matches the search', async () => {
    const stranger = { id: '9', name: 'jordan', tag: 'Repos not checked' }
    const found = (query: string) => (query === 'jordan' ? [stranger] : [])
    render(<BotWhoCanAskPicker bot={bot} service={service(found)} owner="You" onPicked={vi.fn()} />)
    const search = screen.getByPlaceholderText('Search by name or username')
    fireEvent.change(search, { target: { value: 'jordan' } })
    fireEvent.click(await screen.findByText('jordan'))
    expect(screen.getByText('Repos not checked')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'jor' } })
    expect(await screen.findByText('Selected')).toBeTruthy()
    expect(screen.queryByText(/No one found/)).toBeNull()
  })
})

const slackBot: Bot = {
  id: 'reviewer',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

// Slack's search as the cloud answers it: a person, and another app labelled so.
const slackService: BotWhoCanAskService = {
  listed: (members) => [...members],
  stamp: { source: 'slack', workspaceId: 'T1' },
  max: 50,
  search: async () => ({
    ok: true,
    value: {
      members: [
        { id: 'U1', name: 'Dana' },
        { id: 'U0CIAPP', name: 'CI (app)', app: true }
      ],
      complete: true
    }
  }),
  errorMessage: (code) => code,
  searchPlaceholder: 'Search people',
  peopleHeading: 'People in Acme',
  noMatch: () => ({ title: 'No one', detail: '' }),
  ownerId: 'U0OWNER',
  ownerName: null,
  kind: 'slack',
  connector: 'Slack',
  workspace: 'Acme',
  outsiders: null,
  notYet: '',
  accessRequests: null
}

describe('the Who can ask picker', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('offers other Slack apps beside people, and saves a picked one as an app', async () => {
    const picked = vi.fn<(members: BotMember[]) => void>()
    act(() => {
      root.render(
        <BotWhoCanAskPicker bot={slackBot} service={slackService} owner="You" onPicked={picked} />
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    const rows = [...container.querySelectorAll<HTMLElement>('[cmdk-item]')]
    const app = rows.find((row) => row.textContent?.includes('CI (app)'))
    expect(rows.some((row) => row.textContent?.includes('Dana'))).toBe(true)
    expect(app).toBeDefined()
    // Drawn as an app, not by initials.
    expect(app?.querySelector('svg.lucide-bot')).not.toBeNull()

    act(() => app?.click())
    const add = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Add')
    )
    act(() => add?.click())
    expect(picked).toHaveBeenCalledWith([
      { id: 'U0CIAPP', name: 'CI (app)', kind: 'app', source: 'slack', workspaceId: 'T1' }
    ])
  })
})
