// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  setPostAs: vi.fn(),
  calledFor: [] as string[]
}))
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: mocks.open }))
vi.mock('@/lib/bot-connector-host-calls', () => ({
  botSlackCalls: (hostId: string) => {
    mocks.calledFor.push(hostId)
    return { setPostAs: mocks.setPostAs }
  }
}))
vi.mock('@/lib/bot-slack-state', () => ({ refreshBotSlack: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccount: () => ({ state: 'signed-in', email: 'm4air@example.test' })
}))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => 'm4-air' }))

import { BotSlackPostAs } from './BotSlackPostAs'

const SERVER = 'runtime:m4'
const AUTHORIZE = 'https://slack.com/oauth/v2/authorize?x=post-as'

const slack = {
  state: 'installed',
  teamId: 'T1',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U1',
  postAs: 'person',
  postAsPending: 'computer',
  computerName: 'm4-air'
} as Extract<ConnectorBotSlackState, { state: 'installed' }>

afterEach(() => {
  cleanup()
  mocks.open.mockReset()
  mocks.setPostAs.mockReset()
  mocks.calledFor = []
})

describe('BotSlackPostAs', () => {
  it("opens a paired bot's approval in this computer's browser, never the server's", async () => {
    mocks.setPostAs.mockResolvedValue({ ok: true, value: { authorizeUrl: AUTHORIZE } })
    mocks.open.mockReturnValue('system-browser')
    render(<BotSlackPostAs bot={{ id: 'bot-1', hostId: SERVER } as Bot} slack={slack} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
    expect(mocks.open).toHaveBeenCalledWith('local', AUTHORIZE, { local: 'system' })
    // The change itself is still asked of the bot's own computer.
    expect(mocks.calledFor).toContain(SERVER)
  })
})
