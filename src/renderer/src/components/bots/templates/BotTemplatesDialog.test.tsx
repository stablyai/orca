// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => {
  const bots: { name: string }[] = []
  return { createBot: vi.fn(), bots }
})
vi.mock('@/lib/bot-catalog', () => ({
  createBot: mocks.createBot,
  useBots: () => mocks.bots,
  useHostBots: () => [],
  uploadBotAvatar: vi.fn(),
  openBotHomeTab: vi.fn(async () => true),
  readBotAvatarPng: vi.fn(async () => null)
}))
vi.mock('../bot-create-open', () => ({ openCreatedBot: vi.fn(async () => true) }))
vi.mock('../use-bot-agent-choices', () => ({
  useBotAgentChoices: () => ['claude'],
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: ['claude'] })
}))
vi.mock('../BotAgentLaunchPicker', () => ({ BotAgentLaunchPicker: () => null }))

import BotTemplatesDialog from './BotTemplatesDialog'
import { openBotTemplates } from './bot-templates-open'

function renderDialog(): void {
  render(
    <TooltipProvider>
      <BotTemplatesDialog />
    </TooltipProvider>
  )
}

beforeEach(() => {
  useAppStore.setState({
    activeView: 'tasks',
    activeModal: 'none',
    modalData: {},
    botTemplateSelected: null,
    worktreeNavHistory: ['tasks'],
    worktreeNavHistoryIndex: 0
  })
  mocks.bots = [{ name: 'Pull request review' }]
  mocks.createBot.mockResolvedValue({ id: 'b1', name: 'Pull request review 2' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BotTemplatesDialog', () => {
  it('opens over the current view on the template asked for, adding no history entry', () => {
    openBotTemplates('deploy-watch')
    renderDialog()

    expect(screen.getByRole('dialog', { name: 'Bot templates' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: /Deploy watch/ })).toBeTruthy()
    expect(useAppStore.getState()).toMatchObject({
      activeView: 'tasks',
      worktreeNavHistory: ['tasks'],
      worktreeNavHistoryIndex: 0
    })
  })

  it('clears a typed search on the first Esc and closes on the next', () => {
    openBotTemplates()
    renderDialog()
    const search = screen.getByRole('textbox', { name: 'Search templates' })
    fireEvent.change(search, { target: { value: 'release' } })

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveProperty('value', '')
    expect(useAppStore.getState().activeModal).toBe('bot-templates')

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(useAppStore.getState().activeView).toBe('tasks')
  })

  it('filters by category and keeps the search when changing categories', () => {
    openBotTemplates()
    renderDialog()
    const coding = screen.getByRole('radio', { name: 'Coding' })
    const releaseNotes = { name: /^Release notes/ }

    fireEvent.click(coding)
    expect(screen.getByRole('radio', { name: 'Coding', checked: true })).toBe(coding)
    expect(screen.getByRole('option', { name: /^Dependency updates/ })).toBeTruthy()
    expect(screen.queryByRole('option', releaseNotes)).toBeNull()

    const search = screen.getByRole('textbox', { name: 'Search templates' })
    fireEvent.change(search, { target: { value: 'release notes' } })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByRole('option', releaseNotes)).toBeTruthy()
    expect(screen.queryByRole('option', { name: /^Dependency updates/ })).toBeNull()
  })

  it('keeps the detail header and Use template… out of the part that scrolls', () => {
    openBotTemplates('ci-failures')
    renderDialog()
    const scrolling = screen.getByRole('region', { name: 'About CI failures' })

    expect(within(scrolling).getByText('What it does first')).toBeTruthy()
    expect(within(scrolling).queryByRole('button', { name: 'Use template…' })).toBeNull()
    expect(within(scrolling).queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('creates only through New bot, opened over the dialog, with the skills left ticked', async () => {
    openBotTemplates('pr-review')
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Use Pull request review' }))
    const newBot = await screen.findByRole('dialog', { name: 'New bot' })
    expect(useAppStore.getState().activeModal).toBe('bot-templates')
    expect(mocks.createBot).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Pull request review 2')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Add the pr-review-checklist skill' }))
    fireEvent.submit(newBot.querySelector('form')!)
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalledTimes(1))
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({
      name: 'Pull request review 2',
      seed: { templateId: 'pr-review' },
      fromTemplate: { id: 'pr-review', skills: [] }
    })
    await waitFor(() => expect(useAppStore.getState().activeModal).toBe('none'))
  })

  it('gives focus back to what opened New bot: Blank bot after an earlier Use', async () => {
    openBotTemplates('pr-review')
    renderDialog()
    const closeNewBot = async (): Promise<void> => {
      const newBot = await screen.findByRole('dialog', { name: 'New bot' })
      fireEvent.click(within(newBot).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New bot' })).toBeNull())
    }
    const use = screen.getByRole('button', { name: 'Use Pull request review' })
    use.focus()
    fireEvent.click(use)
    await closeNewBot()

    const blank = screen.getByRole('button', { name: 'Blank bot' })
    blank.focus()
    fireEvent.click(blank)
    await closeNewBot()
    expect(document.activeElement).toBe(blank)
  })

  it('in the narrow in-place detail, gives focus back to its Use template…, not the hidden row', async () => {
    openBotTemplates()
    renderDialog()
    // happy-dom lays nothing out, so the dialog measures 0 wide: narrow.
    fireEvent.click(screen.getByRole('option', { name: /^Release notes/ }))
    const back = screen.getByRole('button', { name: 'All templates' })
    const use = within(back.closest('div')!.parentElement!).getByRole('button', {
      name: 'Use template…'
    })
    use.focus()
    fireEvent.click(use)
    const newBot = await screen.findByRole('dialog', { name: 'New bot' })
    fireEvent.click(within(newBot).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New bot' })).toBeNull())
    expect(document.activeElement).toBe(use)
  })
})
