// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import { BotSharedFromSchema } from '../../../../../shared/bots/bot-shared-from'
import { BotSharesSchema } from '../../../../../shared/bots/bot-team-shares'
import { BotTeamShareDialogHost } from '../team-share/BotTeamShareDialogHost'
import type { LinkRead } from '../sharing/use-bot-share-link'
import { BotSharedFromLine } from './BotSharedFromLine'
import { BotSharingPage } from './BotSharingPage'

const { removeBotTeamShare } = vi.hoisted(() => ({ removeBotTeamShare: vi.fn(async () => {}) }))
vi.mock('../team-share/bot-team-share-rpc', () => ({
  addBotTeamShare: vi.fn(),
  removeBotTeamShare,
  resendBotTeamShare: vi.fn()
}))
vi.mock('@/lib/bot-host-orca-account', () => ({
  useBotHostOrcaAccount: () => ({ state: 'signed-in', email: 'jo@acme.co', displayName: 'Jo' })
}))
vi.mock('@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog', () => ({
  useTeamSharingOffered: () => true
}))
vi.mock('../bot-connector-entries', () => ({ useBotConnectorEntries: () => [] }))
vi.mock('../use-bot-host-label', () => ({ useBotHostLabel: () => null }))
vi.mock('../orca-cloud-signed-out', () => ({ useOrcaCloudSignedOut: () => false }))
const linkRead = vi.hoisted(() => {
  const read: { current: LinkRead } = { current: { kind: 'read', link: null } }
  return read
})
vi.mock('../sharing/use-bot-share-link', () => ({
  useBotShareLink: () => ({ read: linkRead.current, reread: () => {}, otherLinks: false })
}))
vi.mock('../sharing/BotShareFlow', () => ({ BotSharePreview: () => null }))

// Shares and copy origin as stored before this page existed: one accepted teammate and one invite.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page reads only these fields.
const bot = {
  id: 'b1',
  name: 'Ada',
  hostId: 'local',
  members: [],
  shares: BotSharesSchema.parse([
    {
      kind: 'account',
      shareId: 's1',
      accountId: 'a1',
      name: 'Dara',
      email: 'dara@acme.co',
      addedAt: 1,
      acceptedAt: 2
    },
    { kind: 'invite', shareId: 's2', email: 'sam@acme.co', addedAt: 2 }
  ]),
  sharedFrom: BotSharedFromSchema.parse({
    shareId: 'l1',
    packageId: 'p1',
    versionId: 'v1',
    sharedBy: 'Dara',
    sharedAt: '2026-11-08T00:00:00Z'
  })
} as unknown as Bot

function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </ConfirmationDialogProvider>
  )
}

afterEach(() => {
  linkRead.current = { kind: 'read', link: null }
  cleanup()
  removeBotTeamShare.mockClear()
})

describe('Settings › Sharing and the Share dialog', () => {
  it('draw one people list: same rows, and a remove on either reaches the same share', () => {
    const page = render(<BotSharingPage bot={bot} />, { wrapper: Providers })
    const pageRows = within(page.container)
      .getAllByRole('listitem')
      .map((row) => row.textContent)
    expect(pageRows).toEqual(['Jo (you)jo@acme.coOwner', 'Daradara@acme.co', 'sam@acme.coInvited'])
    // Teammates have it, so nothing on the page says the agent is not shared.
    expect(screen.queryByText('Not shared')).toBeNull()
    expect(screen.getByText('Create copy link')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Dara' }))
    cleanup()

    render(<BotTeamShareDialogHost bot={bot} onClose={() => {}} />, { wrapper: Providers })
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((row) => row.textContent)
    ).toEqual(pageRows)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Dara' }))
    expect(removeBotTeamShare.mock.calls).toEqual([
      [bot, 's1'],
      [bot, 's1']
    ])
  })

  it('names a copied agent by where it was copied from', () => {
    render(<BotSharedFromLine bot={bot} />)
    expect(screen.getByText('Copied from Dara')).toBeTruthy()
  })

  it('offers Create copy link when signed out, never a spinner', () => {
    linkRead.current = { kind: 'signIn' }
    render(<BotSharingPage bot={bot} />, { wrapper: Providers })
    expect(screen.getByText('Create copy link')).toBeTruthy()
    expect(screen.queryByText('Loading shared links…')).toBeNull()
  })
})
