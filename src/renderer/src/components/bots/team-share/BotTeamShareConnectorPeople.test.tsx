// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import {
  TeamShareConnectorPeople,
  type TeamShareFoundByConnector
} from './BotTeamShareConnectorPeople'

const { updateBot } = vi.hoisted(() => ({
  updateBot: vi.fn(async (): Promise<never> => {
    throw new Error('host gone')
  })
}))
vi.mock('@/lib/bot-catalog', () => ({ updateBot }))
vi.mock('@/lib/bot-access-requests', () => ({
  decideAccessRequest: async () => {},
  takeAccessReview: () => null,
  useAccessRequests: () => [],
  useAccessReview: () => null
}))
vi.mock('@/lib/bot-host-orca-account', () => ({ useBotHostOnOwnAccount: () => true }))
vi.mock('../orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => null }))
// The access confirmation is answered yes.
vi.mock('../bot-access-confirm', () => ({ useConfirmBotAccess: () => async () => true }))
let service: BotWhoCanAskService
vi.mock('../slack/use-slack-who-can-ask', () => ({ useSlackWhoCanAsk: () => service }))

const search = vi.fn<BotWhoCanAskService['search']>(async () => ({
  ok: true,
  value: { members: [{ id: 'U1', name: 'Dana' }], complete: true }
}))

function slackService(outsiders: string | null): BotWhoCanAskService {
  return {
    listed: (members) => members.filter((member) => member.source === 'slack'),
    stamp: { source: 'slack', workspaceId: 'T1' },
    max: 50,
    search,
    errorMessage: (code) => code,
    searchPlaceholder: '',
    peopleHeading: '',
    noMatch: () => ({ title: '', detail: '' }),
    ownerId: 'U0',
    ownerName: null,
    kind: 'slack',
    connector: 'Slack',
    workspace: 'Acme',
    outsiders,
    notYet: '',
    accessRequests: null
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only these fields.
const bot = { id: 'b1', name: 'Ada', hostId: 'local', members: [] } as unknown as Bot
const entry = {
  kind: 'slack',
  key: 'slack:T1',
  teamId: 'T1',
  title: { service: 'Slack', name: 'Acme' }
} as const

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let found: TeamShareFoundByConnector
const report = (update: (all: TeamShareFoundByConnector) => TeamShareFoundByConnector): void => {
  found = update(found)
}

function show(query: string): void {
  act(() => {
    root.render(
      <ul>
        {/* oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a Slack row reads only these entry fields. */}
        <TeamShareConnectorPeople bot={bot} entry={entry as never} query={query} report={report} />
      </ul>
    )
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  search.mockClear()
  found = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('Slack people in the Share dialog', () => {
  it('finds a typed @name, and a failed add says so with Try again', async () => {
    service = slackService('Everyone else in Acme can’t ask.')
    show('@dan')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(search).toHaveBeenCalledWith('dan')
    const answer = found[entry.key]
    expect(answer?.status === 'ready' && answer.suggestions.map((s) => s.key)).toEqual([
      'slack:T1\nU1'
    ])

    await act(async () => {
      if (answer?.status === 'ready') {
        answer.pick(answer.suggestions[0]!.key)
      }
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(updateBot).toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Dana')
  })

  it('never searches a connector that is not set up yet', async () => {
    service = slackService(null)
    show('dan')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(search).not.toHaveBeenCalled()
    expect(found[entry.key]).toEqual({ status: 'off' })
  })
})
