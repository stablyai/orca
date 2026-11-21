// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => new Map<string, string>([['runtime:m4', 'm4 air']]))
vi.mock('./use-bot-host-label', () => ({
  useBotHostLabel: (hostId: string) => hosts.get(hostId) ?? null
}))
vi.mock('./BotPictureButton', () => ({
  BotPictureButton: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>
}))

import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { BotPanelHeader } from './BotPanelHeader'
import { BotPanelHostLine } from './BotPanelHostLine'

const BOT: Bot = {
  id: 'b1',
  name: 'Docs bot',
  hostId: 'local',
  folder: 'docs',
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
const picture: Parameters<typeof BotPanelHeader>[0]['picture'] = {
  value: { kind: 'mascot', index: 0 },
  custom: null,
  pick: () => {},
  upload: () => {},
  undo: () => {},
  color: null,
  pickColor: () => {},
  outfit: null,
  pickOutfit: () => {}
}

function header(hostId: ExecutionHostId, offline = false): string {
  const { container } = render(
    <TooltipProvider>
      <BotPanelHeader
        bot={stampBotHost(hostId, BOT)}
        now={{ needsYou: 0, working: 0 }}
        offline={offline}
        quiet={{ running: 'Nightly report', next: null }}
        picture={picture}
      />
    </TooltipProvider>
  )
  return container.textContent ?? ''
}

function line(hostId: ExecutionHostId, offline: boolean): string {
  const { container } = render(
    <BotPanelHostLine hostId={hostId} offline={offline}>
      {() => 'Idle · next 9:00 PM'}
    </BotPanelHostLine>
  )
  return container.textContent ?? ''
}

afterEach(cleanup)

describe('remote bot host in the panel header', () => {
  it("names a paired server's bot's host", () => {
    expect(header('runtime:m4')).toContain('m4 air')
  })

  it("leaves this computer's bot without a host", () => {
    expect(header('local')).not.toContain('m4 air')
  })

  it("replaces a down server's stale status, keeping the host", () => {
    const text = line('runtime:m4', true)
    expect(text).toContain('m4 air')
    expect(text).not.toContain('next 9:00 PM')
  })

  it('hides the stale activity of a bot whose paired server went offline', () => {
    const previous = useAppStore.getState().folderWorkspaces
    useAppStore.setState({
      folderWorkspaces: [
        makeFolderWorkspace({ id: BOT.folderWorkspaceId, executionHostId: 'runtime:m4' })
      ]
    })
    try {
      expect(header('runtime:m4')).toContain('Nightly report')
      cleanup()
      const text = header('runtime:m4', true)
      expect(text).toContain('m4 air')
      expect(text).toContain('Disconnected')
      expect(text).not.toContain('Nightly report')
    } finally {
      cleanup()
      useAppStore.setState({ folderWorkspaces: previous })
    }
  })

  it('keeps the status while the server is up', () => {
    expect(line('runtime:m4', false)).toContain('next 9:00 PM')
  })
})
