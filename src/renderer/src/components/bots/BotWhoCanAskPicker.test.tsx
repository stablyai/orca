// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, BotMember } from '../../../../shared/bot-types'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'
import type { BotWhoCanAskService } from './BotWhoCanAskList'

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

// Slack's search as the cloud answers it: a person, and another app labelled so.
const service: BotWhoCanAskService = {
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
} as BotWhoCanAskService

describe('the Who can ask picker', () => {
  it('offers other Slack apps beside people, and saves a picked one as an app', async () => {
    const picked = vi.fn<(members: BotMember[]) => void>()
    act(() => {
      root.render(
        <BotWhoCanAskPicker
          bot={{ members: [] } as unknown as Bot}
          service={service}
          owner="You"
          onPicked={picked}
        />
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
