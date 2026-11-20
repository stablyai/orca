// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotWhoCanAskFound, BotWhoCanAskService } from './BotWhoCanAskList'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the picker reads.
const bot = { id: 'bot-1', hostId: 'local', name: 'Atlas', members: [] } as unknown as Bot

const teammates: BotWhoCanAskFound['members'] = [
  { id: '2', name: 'brennanb2025', handle: 'Brennan Benson' },
  { id: '5', name: 'Jinwoo-H', handle: 'Jinwoo Hong' }
]

function service(found: (query: string) => BotWhoCanAskFound['members']): BotWhoCanAskService {
  return {
    listed: () => [],
    stamp: { source: 'github' },
    max: 50,
    search: vi.fn(async (query: string) => ({
      ok: true as const,
      value: { members: found(query), complete: true }
    })),
    errorMessage: (code) => code,
    searchPlaceholder: 'Search by name or username',
    peopleHeading: 'People in your repositories',
    outsideHeading: 'Elsewhere on GitHub',
    noMatch: (query) => ({ title: `No one found for ${query}`, detail: '' }),
    idleHint: { title: 'Type a name or GitHub username', detail: '' },
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
    expect(screen.queryByText('Type a name or GitHub username')).toBeNull()
  })

  it('keeps a stranger with that exact username apart from teammates', async () => {
    const found = (query: string) =>
      query === 'brennan'
        ? [teammates[0], { id: '9', name: 'brennan', outside: true }]
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
})
