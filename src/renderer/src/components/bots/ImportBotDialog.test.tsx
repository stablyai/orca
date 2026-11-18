// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import {
  botNameFromExportFolder,
  type BotImportCandidate,
  type BotImportSource
} from '../../../../shared/bots/bot-import'
import type { BotImportSourcesRead } from './bot-import-sources'
import { BOT_MASCOT_URLS } from './bot-mascots'

const mocks = vi.hoisted(() => {
  const read: { current: BotImportSourcesRead } = { current: { status: 'loading' } }
  return {
    createBot: vi.fn(),
    uploadBotAvatar: vi.fn(),
    openBotHomeTab: vi.fn(async () => true),
    readHostBots: vi.fn((): Bot[] => []),
    agentChoices: vi.fn((): string[] => ['claude']),
    read
  }
})
vi.mock('@/lib/bot-catalog', () => ({
  createBot: mocks.createBot,
  uploadBotAvatar: mocks.uploadBotAvatar,
  openBotHomeTab: mocks.openBotHomeTab,
  readHostBots: mocks.readHostBots,
  readBotAvatarPng: vi.fn(async () => null),
  useHostBots: () => []
}))
vi.mock('./bot-import-sources', () => ({ useBotImportSources: () => mocks.read.current }))
vi.mock('./use-bot-agent-choices', () => ({
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: mocks.agentChoices() })
}))
// The agent picker has its own tests; this stands in for a Set agent in it.
vi.mock('./BotAgentLaunchPicker', () => ({
  BotAgentLaunchPicker: ({
    value,
    onChange
  }: {
    value: { agent: string }
    onChange: (setup: unknown) => void
  }) => (
    <button
      type="button"
      onClick={() => onChange({ agent: value.agent, launch: { model: 'opus' } })}
    >
      {`Agent ${value.agent}`}
    </button>
  )
}))

import { ImportBotDialog } from './ImportBotDialog'

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Molty',
    hostId: 'local',
    folder: 'molty',
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
    updatedAt: 1,
    ...overrides
  }
}

function candidate(name: string, extra: Partial<BotImportCandidate> = {}): BotImportCandidate {
  const id = name.toLowerCase().replace(/ /g, '-')
  return {
    agent: id,
    name,
    path: `~/.openclaw/${id}`,
    absolutePath: `/home/me/.openclaw/${id}`,
    ...extra
  }
}

function found(...sources: BotImportSource[]): void {
  mocks.read.current = { status: 'ready', sources }
}

const writeClipboardText = vi.fn(async (_text: string) => {})
const pickFolder = vi.fn(async (): Promise<string | null> => '/Users/me/Downloads/sage-export')

beforeEach(() => {
  vi.stubGlobal('api', { repos: { pickFolder }, fs: {}, ui: { writeClipboardText } })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mocks.agentChoices.mockReturnValue(['claude'])
  mocks.read.current = { status: 'loading' }
})

function renderDialog(): void {
  render(
    <TooltipProvider>
      <ImportBotDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    </TooltipProvider>
  )
}

const nameInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Name')
const newBotPicture = (): string | null =>
  screen
    .getByRole('button', { name: 'Change picture' })
    .querySelector('img')
    ?.getAttribute('src') ?? null

describe('ImportBotDialog, bots found', () => {
  it('starts on the first bot, follows the pick, and creates with the picture shown', async () => {
    found({ app: 'openclaw', home: '~/.openclaw', bots: [candidate('Molty'), candidate('Scout')] })
    mocks.createBot.mockResolvedValue(bot({ name: 'Scout' }))
    renderDialog()

    expect(nameInput().value).toBe('Molty')
    expect(screen.getByText('2 found')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Molty/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: /Scout/ }))
    expect(nameInput().value).toBe('Scout')

    const shown = newBotPicture()
    fireEvent.click(screen.getByRole('button', { name: /Runs on/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Agent claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Scout' }))
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalled())
    const params = mocks.createBot.mock.calls[0]?.[1]
    expect(params.importFrom).toEqual({
      app: 'openclaw',
      path: '/home/me/.openclaw/scout',
      agent: 'scout',
      name: 'Scout'
    })
    expect(params).toMatchObject({ agent: 'claude', launch: { model: 'opus' } })
    const avatar = parseBotAvatar(params.avatar)
    expect(avatar?.kind === 'mascot' && BOT_MASCOT_URLS[avatar.id]).toBe(shown)
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('moves the pick with the arrow keys, and the list is one Tab stop', async () => {
    found({ app: 'openclaw', home: '~/.openclaw', bots: [candidate('Molty'), candidate('Scout')] })
    renderDialog()
    const molty = screen.getByRole('radio', { name: /Molty/ })
    const scout = screen.getByRole('radio', { name: /Scout/ })
    // Tab lands on the group, which hands focus to the picked row; the rows themselves are not Tab stops.
    const tabStops = (): HTMLElement[] =>
      screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)
    expect(tabStops()).toEqual([])

    molty.focus()
    fireEvent.keyDown(molty, { key: 'ArrowDown' })
    // Radix moves focus on the next task.
    await waitFor(() => expect(document.activeElement).toBe(scout))
    expect(scout.getAttribute('aria-checked')).toBe('true')
    expect(nameInput().value).toBe('Scout')
    expect(tabStops()).toEqual([scout])
  })

  it('does not create on Enter while Create is disabled', () => {
    mocks.agentChoices.mockReturnValue([])
    found({ app: 'openclaw', home: '~/.openclaw', bots: [candidate('Molty')] })
    renderDialog()
    expect(screen.getByRole('button', { name: 'Create Molty' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(nameInput(), { key: 'Enter' })
    expect(mocks.createBot).not.toHaveBeenCalled()
  })

  it('adds New group’s filter only past ten bots', () => {
    const many = Array.from({ length: 11 }, (_, i) => candidate(`Bot ${i + 1}`))
    found({ app: 'openclaw', home: '~/.openclaw', bots: many.slice(0, 10) })
    renderDialog()
    expect(screen.queryByLabelText('Filter bots')).toBeNull()
    cleanup()

    found({ app: 'openclaw', home: '~/.openclaw', bots: many })
    renderDialog()
    fireEvent.change(screen.getByLabelText('Filter bots'), { target: { value: 'bot 1' } })
    // Bot 1, Bot 10, Bot 11; "Another app…" stays.
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /Another app/ })).toBeTruthy()
  })

  it('offers Update for a bot imported before, and Create once a new name is typed', async () => {
    const existing = bot({ id: 'bot-9', name: 'Molty' })
    mocks.readHostBots.mockReturnValue([existing])
    found({
      app: 'openclaw',
      home: '~/.openclaw',
      bots: [candidate('Molty', { importedAs: { botId: 'bot-9', name: 'Molty' } })]
    })
    renderDialog()

    expect(nameInput().value).toBe('')
    expect(screen.getByText('Molty came from this bot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update Molty' }))
    await waitFor(() =>
      expect(mocks.openBotHomeTab).toHaveBeenCalledWith(existing, {
        draft: 'Bring over anything new from Molty in OpenClaw.'
      })
    )
    cleanup()

    renderDialog()
    fireEvent.change(nameInput(), { target: { value: 'Molty two' } })
    expect(screen.queryByRole('button', { name: /Update/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Molty two' })).toBeTruthy()
  })
})

describe('ImportBotDialog, another app', () => {
  it('opens straight on the steps when nothing is found, with Cancel and no Back', () => {
    found()
    renderDialog()
    expect(screen.getByText('Send your old bot this message')).toBeTruthy()
    expect(screen.getByText('Add its folder')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('suggests a name from the export folder, taken by Tab, and sends the folder and reply', async () => {
    found({ app: 'openclaw', home: '~/.openclaw', bots: [candidate('Molty')] })
    mocks.createBot.mockResolvedValue(bot({ name: 'Sage' }))
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Another app/ }))
    expect(nameInput().value).toBe('')
    expect(screen.queryByLabelText('Its reply')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(writeClipboardText.mock.calls[0]?.[0]).toMatch(/^I'm moving to another assistant/)
    fireEvent.click(screen.getByRole('button', { name: 'choose a folder…' }))
    await waitFor(() => expect(screen.getByText('/Users/me/Downloads/sage-export')).toBeTruthy())

    fireEvent.keyDown(nameInput(), { key: 'Tab' })
    expect(nameInput().value).toBe('Sage')
    fireEvent.change(screen.getByLabelText('Its reply'), { target: { value: 'Saved SOUL.md' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Sage' }))
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalled())
    expect(mocks.createBot.mock.calls[0]?.[1].importFrom).toEqual({
      app: 'export',
      path: '/Users/me/Downloads/sage-export',
      name: 'Sage',
      reply: 'Saved SOUL.md'
    })
  })

  it('goes Back to the found bots', () => {
    found({ app: 'openclaw', home: '~/.openclaw', bots: [candidate('Molty')] })
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Another app/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('radio', { name: /Molty/ })).toBeTruthy()
  })
})

describe('botNameFromExportFolder', () => {
  it('names the bot from the folder the prompt asks for', () => {
    expect(botNameFromExportFolder('/Users/me/Downloads/sage-export')).toBe('Sage')
    expect(botNameFromExportFolder('C:\\Users\\me\\Downloads\\research_desk-export\\')).toBe(
      'Research desk'
    )
    expect(botNameFromExportFolder('/Users/me/Downloads/molty')).toBe('Molty')
    expect(botNameFromExportFolder('/Users/me/Downloads/-export')).toBeNull()
  })
})
