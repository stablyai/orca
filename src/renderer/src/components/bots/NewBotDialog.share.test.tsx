// @vitest-environment happy-dom
// New bot opened from a reviewed link: the regular dialog, making the reviewed bot.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useReducer } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import type { BotShareReview } from '../../../../shared/bots/bot-share-received'

const mocks = vi.hoisted(() => {
  const hostBots: { name: string }[] = []
  return {
    createBot: vi.fn(),
    uploadBotAvatar: vi.fn(),
    openBotHomeTab: vi.fn(async () => true),
    hostBots,
    listeners: new Set<() => void>()
  }
})
vi.mock('@/lib/bot-catalog', () => ({
  createBot: mocks.createBot,
  uploadBotAvatar: mocks.uploadBotAvatar,
  openBotHomeTab: mocks.openBotHomeTab,
  readBotAvatarPng: vi.fn(async () => null),
  // The picked computer's bots, as the catalog lists them; `setHostBots` stands for a later listing.
  useHostBots: () => {
    const [, rerender] = useReducer((n: number) => n + 1, 0)
    useEffect(() => {
      mocks.listeners.add(rerender)
      return () => void mocks.listeners.delete(rerender)
    }, [])
    return mocks.hostBots
  }
}))
vi.mock('./use-bot-agent-choices', () => ({
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: ['claude', 'pi'] })
}))
// The picker commits a whole setup per pick, as the real one does on an agent tab.
vi.mock('./BotAgentLaunchPicker', () => ({
  BotAgentLaunchPicker: ({
    value,
    onChange
  }: {
    value: { agent: string; permissionMode?: string }
    onChange: (setup: { agent: string; permissionMode?: string }) => void
  }) => (
    <span>
      <span>{`Agent ${value.agent} ${value.permissionMode ?? 'inherit'}`}</span>
      <button type="button" onClick={() => onChange({ agent: 'pi' })}>
        pick pi
      </button>
      <button
        type="button"
        onClick={() =>
          onChange({
            agent: 'claude',
            ...(value.permissionMode ? { permissionMode: value.permissionMode } : {})
          })
        }
      >
        pick claude
      </button>
    </span>
  )
}))

function setHostBots(bots: { name: string }[]): void {
  mocks.hostBots = bots
  act(() => mocks.listeners.forEach((listener) => listener()))
}

import { NewBotDialog } from './NewBotDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.hostBots = []
})

const review: BotShareReview = {
  reviewId: 'review-1',
  shareId: 'share-1',
  versionId: 'version-1',
  publisher: 'Dara',
  publishedAt: '2026-11-08T00:00:00.000Z',
  bot: {
    schemaVersion: 1,
    name: 'Release notes',
    purpose: 'Drafts release notes.',
    agentHint: 'claude',
    skills: [],
    tools: [],
    connectors: [],
    schedules: [],
    eventSuggestions: [],
    memory: []
  },
  files: [],
  flags: [],
  leftOut: [],
  avatarDataUrl: 'data:image/png;base64,UE5H'
}

const created: Bot = {
  id: 'bot-1',
  name: 'Release notes',
  hostId: 'local',
  folder: 'release-notes',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

function renderFromShare() {
  const source = { review, toolIds: ['tool-1'], onBack: vi.fn(), onMoved: vi.fn() }
  const onOpenChange = vi.fn()
  render(
    <TooltipProvider>
      <NewBotDialog open onOpenChange={onOpenChange} fromShare={source} />
    </TooltipProvider>
  )
  return { source, onOpenChange }
}

describe('NewBotDialog from a link', () => {
  it('is the regular dialog with the link’s name, no purpose, and Ask picked first', () => {
    renderFromShare()
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Release notes')
    expect(screen.getByText('Agent claude ask')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Template' })).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('suggests a name free on the picked computer until the owner types one', () => {
    renderFromShare()
    const nameField = screen.getByLabelText('Name')
    // The picked computer's Release notes is listed after the dialog opened.
    setHostBots([{ name: 'Release notes' }])
    expect(nameField).toHaveProperty('value', 'Release notes 2')
    fireEvent.change(nameField, { target: { value: 'Mine' } })
    setHostBots([{ name: 'Release notes' }, { name: 'Release notes 2' }])
    expect(nameField).toHaveProperty('value', 'Mine')
  })

  it('keeps Ask after moving through an agent with no permissions and back', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { onOpenChange } = renderFromShare()
    fireEvent.click(screen.getByRole('button', { name: 'pick pi' }))
    expect(screen.getByText('Agent pi inherit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'pick claude' }))
    expect(screen.getByText('Agent claude ask')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, created))
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({
      agent: 'claude',
      permissionMode: 'ask'
    })
  })

  it('creates on the submit shortcut from the opening focus', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { onOpenChange } = renderFromShare()
    const form = document.querySelector('form')
    await waitFor(() => expect(document.activeElement).toBe(form))
    const mac = navigator.userAgent.includes('Mac')
    fireEvent.keyDown(form ?? document.body, { key: 'Enter', metaKey: mac, ctrlKey: !mac })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, created))
  })

  it('opens with the form focused, not the prefilled name', async () => {
    renderFromShare()
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('form')))
  })

  it('makes the reviewed bot with the shared picture written by Create', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { onOpenChange } = renderFromShare()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, created))
    const [hostId, params] = mocks.createBot.mock.calls[0] ?? []
    expect(hostId).toBe('local')
    expect(params).toMatchObject({
      name: 'Release notes',
      agent: 'claude',
      permissionMode: 'ask',
      fromShare: { reviewId: 'review-1', toolIds: ['tool-1'] }
    })
    expect(params).not.toHaveProperty('avatar')
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('goes back to the review when the link moved, and on Back', async () => {
    mocks.createBot.mockRejectedValue(new Error('bot_share_updated'))
    const { source, onOpenChange } = renderFromShare()
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(source.onMoved).toHaveBeenCalledWith('updated'))
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(source.onBack).toHaveBeenCalled()
  })
})
