// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

const mocks = vi.hoisted(() => {
  const state: {
    open: ReturnType<typeof vi.fn>
    serverOpen: ReturnType<typeof vi.fn>
    setPostAs: ReturnType<typeof vi.fn>
    calledFor: string[]
  } = {
    open: vi.fn(),
    serverOpen: vi.fn(),
    setPostAs: vi.fn(),
    calledFor: []
  }
  return state
})
// A server's Orca browser: never used for Slack's pages.
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: mocks.serverOpen }))
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

import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { BotSlackPostAs } from './BotSlackPostAs'

const SERVER: ExecutionHostId = 'runtime:m4'
const AUTHORIZE = 'https://slack.com/oauth/v2/authorize?x=post-as'

const slack: Extract<ConnectorBotSlackState, { state: 'installed' }> = {
  state: 'installed',
  teamId: 'T1',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U1',
  postAs: 'person',
  postAsPending: 'computer',
  computerName: 'm4-air'
}

const pairedBot: Bot = stampBotHost(SERVER, {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
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
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  mocks.serverOpen.mockReset()
  mocks.open.mockReset()
  mocks.setPostAs.mockReset()
  mocks.calledFor = []
})

describe('BotSlackPostAs', () => {
  it("opens a paired bot's approval in this computer's browser, never the server's", async () => {
    mocks.setPostAs.mockResolvedValue({ ok: true, value: { authorizeUrl: AUTHORIZE } })
    mocks.open.mockResolvedValue(undefined)
    Object.assign(window, { api: { shell: { openUrl: mocks.open } } })
    render(<BotSlackPostAs bot={pairedBot} slack={slack} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
    expect(mocks.open).toHaveBeenCalledWith(AUTHORIZE)
    expect(mocks.serverOpen).not.toHaveBeenCalled()
    // The change itself is still asked of the bot's own computer.
    expect(mocks.calledFor).toContain(SERVER)
  })

  it('keeps Approve in Slack busy until the browser answers', async () => {
    mocks.setPostAs.mockResolvedValue({ ok: true, value: { authorizeUrl: AUTHORIZE } })
    let launched: () => void = () => {}
    mocks.open.mockReturnValue(new Promise<void>((resolve) => (launched = resolve)))
    Object.assign(window, { api: { shell: { openUrl: mocks.open } } })
    render(<BotSlackPostAs bot={pairedBot} slack={slack} />)

    const approve = screen.getByRole('button', { name: 'Approve in Slack' })
    fireEvent.click(approve)
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
    expect(approve).toHaveProperty('disabled', true)
    fireEvent.click(approve)
    expect(mocks.setPostAs).toHaveBeenCalledTimes(1)
    await act(async () => launched())
    expect(approve).toHaveProperty('disabled', false)
  })

  it('keeps Approve in Slack to try again when the browser could not be opened', async () => {
    mocks.setPostAs.mockResolvedValue({ ok: true, value: { authorizeUrl: AUTHORIZE } })
    mocks.open.mockRejectedValue(new Error('no default browser'))
    Object.assign(window, { api: { shell: { openUrl: mocks.open } } })
    render(<BotSlackPostAs bot={pairedBot} slack={slack} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve in Slack' })).toHaveProperty(
        'disabled',
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Approve in Slack' }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2))
  })
})
