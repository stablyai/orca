// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot, BotMember } from '../../../../../shared/bot-types'
import { BotSharesSchema } from '../../../../../shared/bots/bot-team-shares'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { BotTeamShareDialogHost } from './BotTeamShareDialogHost'

const state = vi.hoisted(() => ({ signedIn: false, slack: false }))
vi.mock('./bot-team-share-rpc', () => ({
  addBotTeamShare: vi.fn(),
  removeBotTeamShare: vi.fn(),
  resendBotTeamShare: vi.fn()
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccount: () =>
    state.signedIn ? { state: 'signed-in', email: 'jo@acme.co', displayName: 'Jo' } : null,
  useBotHostOnOwnAccount: () => true
}))
vi.mock('@/lib/bot-access-requests', () => ({
  decideAccessRequest: async () => {},
  takeAccessReview: () => null,
  useAccessRequests: () => [],
  useAccessReview: () => null
}))
vi.mock('../bot-connector-entries', () => ({
  useBotConnectorEntries: () =>
    state.slack
      ? [
          {
            kind: 'slack',
            key: 'slack:T1',
            teamId: 'T1',
            title: { service: 'Slack', name: 'Acme' }
          }
        ]
      : []
}))
vi.mock('../slack/use-slack-who-can-ask', () => ({ useSlackWhoCanAsk: () => slackService }))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => null }))
vi.mock('../orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only these fields.
const slackService = {
  listed: (members: readonly BotMember[]) => members.filter((member) => member.source === 'slack'),
  stamp: { source: 'slack', workspaceId: 'T1' },
  max: 50,
  outsiders: null,
  kind: 'slack',
  connector: 'Slack',
  workspace: 'Acme',
  accessRequests: null
} as unknown as BotWhoCanAskService

function agent(fields: Partial<Bot>): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog reads only these fields.
  return { id: 'ivy', name: 'Ivy', hostId: 'local', avatar: null, members: [], ...fields } as Bot
}

function dialog(bot: Bot): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <TooltipProvider>
        <BotTeamShareDialogHost bot={bot} onClose={() => {}} />
      </TooltipProvider>
    </ConfirmationDialogProvider>
  )
}

async function heading(bot: Bot): Promise<boolean> {
  await act(async () => {
    render(dialog(bot))
  })
  return screen.queryByText('People with access') !== null
}

afterEach(() => {
  cleanup()
  state.signedIn = false
  state.slack = false
})

describe('the Share dialog’s People with access heading', () => {
  it('shows only once someone besides the owner has access or an invite', async () => {
    expect(await heading(agent({}))).toBe(false)
    cleanup()

    state.signedIn = true
    expect(await heading(agent({}))).toBe(false)
    expect(screen.getByText('Jo (you)')).toBeTruthy()
    cleanup()

    state.slack = true
    expect(await heading(agent({}))).toBe(false)
    cleanup()

    const invite = BotSharesSchema.parse([
      { kind: 'invite', shareId: 's1', email: 'dana@acme.co', addedAt: 1 }
    ])
    state.slack = false
    expect(await heading(agent({ shares: invite }))).toBe(true)
    cleanup()

    state.slack = true
    const member = { id: 'U1', name: 'Sam', source: 'slack', workspaceId: 'T1' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a Slack member as Who can ask stores it.
    expect(await heading(agent({ members: [member] as unknown as BotMember[] }))).toBe(true)
    expect(screen.getByText('Sam')).toBeTruthy()
  })

  it("shows once a connector's members arrive after the dialog opened", async () => {
    state.slack = true
    let view!: ReturnType<typeof render>
    await act(async () => {
      view = render(dialog(agent({})))
    })
    expect(screen.queryByText('People with access')).toBeNull()
    const member = { id: 'U1', name: 'Sam', source: 'slack', workspaceId: 'T1' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a Slack member as Who can ask stores it.
    view.rerender(dialog(agent({ members: [member] as unknown as BotMember[] })))
    expect(screen.getByText('People with access')).toBeTruthy()
  })
})
