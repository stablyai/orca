// @vitest-environment happy-dom
// The group header's face and an Items row face, mounted once, show a paired server bot's picture after
// it comes back, and keep it when a saved turn's older version takes the bot's cache slot and the
// current read then answers empty. Seeded data only; avatar transport is controlled.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  environment,
  status
} from '@/components/sidebar/worktree-list/listing/host-status-test-fixtures'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotGroup } from '../../../../../shared/bots/bot-group'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { syncBotHostListing, type BotHostListingInput } from '@/lib/bot-host-listing'

type Read = { botId: string; settle: (png: string | null | Error) => void }
const avatars = vi.hoisted((): { reads: Read[] } => ({ reads: [] }))

vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readBotAvatarPng: (bot: { id: string }) =>
    new Promise<string | null>((resolve, reject) => {
      avatars.reads.push({
        botId: bot.id,
        settle: (png) => (png instanceof Error ? reject(png) : resolve(png))
      })
    })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () => new Promise(() => {})
}))
vi.mock('@/lib/window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))

import { BotAvatar } from '../BotAvatar'
import { BotGroupPanelHeader } from '../BotGroupPanelHeader'
import { BotItemRowFace } from './BotItemRowFace'
import { BotGroupFacePicturesContext, useBotGroupFacePictures } from './bot-group-face-pictures'

const HOST: ExecutionHostId = 'runtime:m4'
const PNG = 'data:image/png;base64,UE5H'
const CONNECTED: RuntimeEnvironmentStatus = {
  status: { ...status('runtime'), capabilities: ['bots.mobile.v1'] },
  checkedAt: 1
}
const DISCONNECTED: RuntimeEnvironmentStatus = { status: null, checkedAt: 1 }

function hostIs(entry: RuntimeEnvironmentStatus): void {
  const input: BotHostListingInput = {
    runtimeEnvironments: [environment('m4')],
    folderWorkspaces: [],
    runtimeEnvironmentCatalogHydrated: false,
    runtimeStatusByEnvironmentId: new Map([['m4', entry]])
  }
  act(() => syncBotHostListing(input, false))
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

// Seeded bot and group, no real data.
/** A paired server's bot or group as the listing stamps it with that server's id (bot-catalog-snapshot.ts). */
function onHost<T extends { hostId: string }>(stored: T, hostId: ExecutionHostId): T {
  return { ...stored, hostId }
}

const storedBot: Bot = {
  id: 'seeded-bot',
  name: 'Seeded bot',
  // A host stores its own bots as `local`; the listing stamps the server that read them.
  hostId: 'local',
  folder: 'seeded-bot',
  folderWorkspaceId: 'seeded-home',
  agent: 'claude',
  avatar: 'upload:v1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const bot = onHost(storedBot, HOST)
const storedGroup: BotGroup = {
  id: 'seeded-group',
  name: 'Seeded group',
  hostId: 'local',
  revision: 1,
  createdAt: 1,
  folder: 'seeded-group',
  folderWorkspaceId: 'seeded-group-home',
  replyMode: { kind: 'mentions' },
  members: [{ botId: storedBot.id, sessionId: 'room' }]
}
const group = onHost(storedGroup, HOST)

/** The Items panel's provider wiring (BotGroupItemsPanel): one face-picture store around its rows. */
function PanelRow({ member }: { member: Bot }): React.JSX.Element {
  const facePictures = useBotGroupFacePictures()
  return (
    <BotGroupFacePicturesContext.Provider value={facePictures}>
      <div data-testid="row">
        <BotItemRowFace bot={member} />
      </div>
    </BotGroupFacePicturesContext.Provider>
  )
}

function Screen(): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <TooltipProvider>
        <div data-testid="header">
          <BotGroupPanelHeader
            group={group}
            members={[bot]}
            needsYou={0}
            working={0}
            next={null}
            now={1}
            filter={null}
          />
        </div>
        <PanelRow member={bot} />
      </TooltipProvider>
    </ConfirmationDialogProvider>
  )
}

afterEach(() => cleanup())

it('the mounted header face and row face keep the picture through the historical displacement and an empty answer', async () => {
  setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
  hostIs(CONNECTED)
  const view = render(<Screen />)
  await flush()
  const headerSlot = view.getByTestId('header').querySelector('[data-testid="bot-group-faces"]')
  const rowSlot = view.getByTestId('row')
  expect(headerSlot).not.toBeNull()
  // Both drawn faces share read A.
  expect(avatars.reads).toHaveLength(1)
  const before = avatars.reads[0]

  hostIs(DISCONNECTED)
  hostIs(CONNECTED)
  await flush()
  expect(avatars.reads).toHaveLength(2)
  const after = avatars.reads[1]

  before.settle('UE5H')
  await flush()
  const headerImg = headerSlot!.querySelector('img')
  const rowImg = rowSlot.querySelector('img')
  expect(headerImg?.getAttribute('src')).toBe(PNG)
  expect(rowImg?.getAttribute('src')).toBe(PNG)

  // A saved chat turn draws the same bot with the version it had then (BotGroupTurn reads it the same way).
  const history = render(<BotAvatar bot={{ ...bot, avatar: 'upload:v0' }} />)
  await flush()
  expect(avatars.reads).toHaveLength(3)

  after.settle(null)
  await flush()
  expect(headerSlot!.querySelector('img')).toBe(headerImg)
  expect(headerImg?.getAttribute('src')).toBe(PNG)
  expect(rowSlot.querySelector('img')).toBe(rowImg)
  expect(rowImg?.getAttribute('src')).toBe(PNG)
  history.unmount()
  view.unmount()
})
