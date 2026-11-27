// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => new Map<string, string>([['runtime:m4', 'm4 air']]))
vi.mock('./use-bot-host-label', () => ({
  useBotHostLabel: (hostId: string) => hosts.get(hostId) ?? null
}))

import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { BotRow } from './BotRow'

const BOT: Bot = {
  id: 'b1',
  name: 'Pull request review',
  hostId: 'local',
  folder: 'pr-review',
  folderWorkspaceId: 'fw-b1',
  agent: 'claude',
  avatar: mascotAvatar('M1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-b1',
  createdAt: 1,
  updatedAt: 1
}

function renderRow(hostId: ExecutionHostId): string {
  const bot = stampBotHost(hostId, BOT)
  const home = makeFolderWorkspace({
    id: bot.folderWorkspaceId,
    name: bot.name,
    folderPath: `/bots/${bot.folder}`,
    executionHostId: hostId
  })
  const { container } = render(
    <ConfirmationDialogProvider>
      <TooltipProvider>
        <BotRow bot={bot} home={home} isActive={false} onOpen={() => {}} />
      </TooltipProvider>
    </ConfirmationDialogProvider>
  )
  return container.textContent ?? ''
}

afterEach(cleanup)

describe('remote bot host badge in the sidebar row', () => {
  it("shows a paired server's name on its bot row", () => {
    expect(renderRow('runtime:m4')).toContain('m4 air')
  })

  it("leaves this computer's bot row unlabelled", () => {
    expect(renderRow('local')).not.toContain('m4 air')
  })
})
