// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import { BotRow } from './BotRow'

vi.mock('@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog', () => ({
  useTeamSharingOffered: () => true,
  useSharedBotHostOf: () => null
}))
vi.mock('./team-share/BotTeamShareDialogHost', () => ({
  BotTeamShareDialogHost: ({ bot }: { bot: Bot }) => <div role="dialog">{bot.id}</div>
}))

const bot: Bot = {
  id: 'ada',
  name: 'Ada',
  hostId: 'local',
  folder: 'ada',
  folderWorkspaceId: 'fw-ada',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-ada',
  createdAt: 1,
  updatedAt: 1
}

describe('BotRow context menu', () => {
  it('Share… opens the Share dialog for that row', () => {
    render(
      <ConfirmationDialogProvider>
        <TooltipProvider>
          <BotRow
            bot={bot}
            home={makeFolderWorkspace({ id: 'fw-ada', folderPath: '/bots/ada' })}
            isActive={false}
            onOpen={() => {}}
          />
        </TooltipProvider>
      </ConfirmationDialogProvider>
    )
    fireEvent.contextMenu(screen.getByText('Ada'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share…' }))
    expect(screen.getByRole('dialog').textContent).toBe('ada')
  })
})
