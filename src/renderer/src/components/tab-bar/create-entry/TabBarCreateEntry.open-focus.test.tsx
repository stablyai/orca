// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { NewTabAgentMenuModel } from '../../agent/launch-menu/new-tab-agent-menu-model'

vi.mock('../../file-actions/quick-open/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({
    files: [],
    loading: false,
    loadError: null
  })
}))
vi.mock('@/lib/bot-catalog', () => ({
  startBotSession: vi.fn(async () => 'session'),
  newBotHomeChat: vi.fn(async () => 'home')
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn(async () => true)
}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn()
}))

import TabBarCreateEntry from './TabBarCreateEntry'
import { BotNewChatMenuItems } from '../../bots/BotNewChatMenuItems'

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: '🦉',
  paused: false,
  notifications: {
    needsPermission: true,
    taskComplete: true,
    couldNotFinish: true
  },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const botMenuModel = {
  state: 'settled',
  rows: [
    { kind: 'chat', agent: 'claude' },
    { kind: 'chat', agent: 'codex' }
  ],
  detection: {
    detectedIds: [],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    needsServerUpdate: false,
    refresh: async () => []
  }
} satisfies NewTabAgentMenuModel

// Mirrors tab-bar-surface: the omnibox entry, then a bot home's chat rows.
function NewTabMenu({ withBot }: { withBot: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <TooltipProvider>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabBarCreateEntry
            worktreeId="wt"
            groupId="g"
            menuOpen={open}
            onOpenEntry={vi.fn().mockResolvedValue(undefined)}
          />
          {withBot ? <BotNewChatMenuItems bot={bot} model={botMenuModel} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

function openMenu(): void {
  const trigger = screen.getByRole('button', { name: 'New tab' })
  act(() => {
    trigger.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse'
      })
    )
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('new tab menu omnibox focus', () => {
  it('focuses the omnibox when the + menu opens', async () => {
    render(<NewTabMenu withBot={false} />)
    openMenu()

    const input = await screen.findByRole('combobox')
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("focuses the omnibox in a bot's home too, with the bot's chat rows still listed", async () => {
    render(<NewTabMenu withBot />)
    openMenu()

    const input = await screen.findByRole('combobox')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(screen.getByRole('menuitem', { name: /New Home Chat/ })).toBeTruthy()
    // Open-time focus lands on an animation frame; let a later frame run so a competing grab would show.
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    expect(document.activeElement).toBe(input)
  })
})
