// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { mascotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'

const mocks = vi.hoisted(() => {
  const picked: { agent: ((agent: string, launch?: unknown) => void) | null } = { agent: null }
  return {
    uploadBotAvatar: vi.fn(async (_botId: string, _png: string) => ({})),
    readBotAvatarPng: vi.fn(async () => 'UE5H'),
    openBotChat: vi.fn(async (_botId: string) => 'home-2'),
    confirm: vi.fn(async (_options: { title: string; details?: React.ReactNode }) => true),
    picked
  }
})
vi.mock('@/lib/bot-catalog', () => ({
  uploadBotAvatar: mocks.uploadBotAvatar,
  readBotAvatarPng: mocks.readBotAvatarPng,
  openBotChat: mocks.openBotChat
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))
vi.mock('@/components/bots/bot-avatar-upload', () => ({
  squareAvatarPng: vi.fn(async () => 'TkVX')
}))
vi.mock('@/components/bots/use-bot-agent-choices', () => ({
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: ['claude', 'codex'] })
}))
// Stands in for a Set agent in the agent picker.
vi.mock('@/components/bots/BotAgentLaunchPicker', () => ({
  BotAgentLaunchPicker: ({ onChange }: { onChange: (setup: unknown) => void }) => {
    mocks.picked.agent = (agent: string, launch?: unknown) => onChange({ agent, launch })
    return null
  }
}))

import { BotPictureButton } from '@/components/bots/BotPictureButton'
import { BotAgentSettings } from './BotGeneralSettings'
import { BOT_PICTURE_SAVE_DELAY_MS, useBotPictureSetting } from './use-bot-picture-setting'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Scout',
    hostId: 'local',
    folder: 'scout',
    folderWorkspaceId: 'fw-1',
    agent: 'claude',
    avatar: mascotAvatar('B1'),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: { appId: 'A1', teamId: 'T05' },
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** The picture as the settings header shows it. */
function Picture({
  bot,
  update
}: {
  bot: Bot
  update: (updates: { avatar?: string | null }) => Promise<Bot | null>
}): React.JSX.Element {
  const picture = useBotPictureSetting(bot, update)
  return <BotPictureButton bot={bot} picture={picture} avatarClassName="size-10" />
}

function renderSection(saved: Bot, openPicture = true) {
  const update = vi.fn(
    async ({ avatar }: { avatar?: string | null; agent?: string }): Promise<Bot | null> => ({
      ...saved,
      avatar: avatar ?? saved.avatar
    })
  )
  const view = (next: Bot) => (
    <TooltipProvider>
      <Picture bot={next} update={update} />
      <BotAgentSettings bot={next} update={update} />
    </TooltipProvider>
  )
  const { rerender, unmount } = render(view(saved))
  if (openPicture) {
    fireEvent.click(screen.getByRole('button', { name: 'Edit bot picture' }))
  }
  const announced = (): string | null =>
    screen.getByRole('group', { name: 'Picture' }).querySelector('[aria-live]')?.textContent ?? null
  const step = (name: 'Next picture' | 'Previous picture'): void => {
    fireEvent.click(screen.getByRole('button', { name }))
  }
  const settle = async (): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(BOT_PICTURE_SAVE_DELAY_MS)
    })
  }
  const shown = (): string | null | undefined =>
    document.querySelector('[data-position="current"] img')?.getAttribute('src')
  return {
    update,
    announced,
    step,
    settle,
    shown,
    rerender: (next: Bot) => rerender(view(next)),
    unmount
  }
}

describe('Bot picture', () => {
  it('shows each step at once and saves only the last one', async () => {
    vi.useFakeTimers()
    const { update, announced, step, settle } = renderSection(bot())
    expect(announced()).toBe('Mascot 2 of 19')
    expect(screen.getByText("Changes your bot's picture in Slack too.")).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Shuffle picture' })).toBeNull()

    step('Next picture')
    step('Next picture')
    step('Next picture')
    expect(announced()).toBe('Mascot 5 of 19')
    expect(update).not.toHaveBeenCalled()

    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar('F1') })
  })

  it('saves a pending step when Settings closes', () => {
    vi.useFakeTimers()
    const { update, step, unmount } = renderSection(bot())
    step('Next picture')
    unmount()
    expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar('D1') })
  })

  it('saves nothing when the owner browses past an upload and back', async () => {
    const { update, step, settle, shown } = renderSection(bot({ avatar: 'upload:v1' }))
    await waitFor(() => expect(shown()).toBe('data:image/png;base64,UE5H'))
    vi.useFakeTimers()

    step('Previous picture')
    step('Next picture')
    await settle()
    expect(update).not.toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('restores an upload when the owner steps back to it after a mascot was saved', async () => {
    const { update, step, settle, shown, rerender, announced } = renderSection(
      bot({ avatar: 'upload:v1' })
    )
    await waitFor(() => expect(shown()).toBe('data:image/png;base64,UE5H'))
    vi.useFakeTimers()

    step('Previous picture')
    await settle()
    expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar('T1') })
    rerender(bot({ avatar: mascotAvatar('T1') }))
    expect(announced()).toBe('Mascot 19 of 19')

    step('Next picture')
    expect(announced()).toBe('Your image')
    await settle()
    expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot-1' }),
      'UE5H'
    )
  })

  it('keeps an emoji picture so stepping back restores it', async () => {
    vi.useFakeTimers()
    const { update, step, settle, rerender, announced } = renderSection(bot({ avatar: '🦊' }))
    expect(announced()).toBe('Current picture')

    step('Next picture')
    await settle()
    expect(update).toHaveBeenLastCalledWith({ avatar: mascotAvatar('A1') })
    rerender(bot({ avatar: mascotAvatar('A1') }))

    step('Previous picture')
    expect(screen.getByRole('group', { name: 'Picture' }).textContent).toContain('🦊')
    await settle()
    expect(update).toHaveBeenLastCalledWith({ avatar: '🦊' })
  })

  it('keeps a retired mascot as the current picture, so stepping back restores it', async () => {
    vi.useFakeTimers()
    const { update, step, settle, rerender, announced, shown } = renderSection(
      bot({ avatar: mascotAvatar('S2') })
    )
    expect(announced()).toBe('Current picture')
    expect(shown()).toContain('S2')

    step('Next picture')
    await settle()
    expect(update).toHaveBeenLastCalledWith({ avatar: mascotAvatar('A1') })
    rerender(bot({ avatar: mascotAvatar('A1') }))

    step('Previous picture')
    await settle()
    expect(update).toHaveBeenLastCalledWith({ avatar: mascotAvatar('S2') })
  })

  it('saves once when Settings closes after the step was saved', async () => {
    vi.useFakeTimers()
    const { update, step, settle, unmount } = renderSection(bot())
    step('Next picture')
    await settle()
    unmount()
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('ends on the upload when the owner steps back to it while it is still sending', async () => {
    let finish: (saved: Bot) => void = () => {}
    mocks.uploadBotAvatar.mockImplementationOnce(
      () => new Promise<Bot>((resolve) => (finish = resolve))
    )
    const { update, step, settle, announced } = renderSection(bot())
    const input = document.querySelector('input[type="file"]')
    if (!input) {
      throw new Error('no file input')
    }
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] }
    })
    await waitFor(() => expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()

    step('Next picture')
    await settle()
    step('Previous picture')
    await settle()
    expect(announced()).toBe('Your image')
    await act(async () => finish(bot({ avatar: 'upload:v2' })))

    expect(update).not.toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)
    expect(announced()).toBe('Your image')
  })

  it('brings back the bot picture when an upload is refused', async () => {
    mocks.uploadBotAvatar.mockRejectedValueOnce(new Error('bot_avatar_invalid'))
    const { update, announced } = renderSection(bot({ avatar: '🦊' }))
    const group = screen.getByRole('group', { name: 'Picture' })
    const input = document.querySelector('input[type="file"]')
    if (!input) {
      throw new Error('no file input')
    }
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] }
    })
    await waitFor(() => expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1))

    await waitFor(() => expect(announced()).toBe('Current picture'))
    expect(group.textContent).toContain('🦊')
    expect(group.querySelector('img[src="data:image/png;base64,TkVX"]')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('saves a pasted image at once and Undo puts the mascot back', async () => {
    const { update, shown } = renderSection(bot())
    const popover = screen.getByRole('dialog')
    fireEvent.paste(popover, {
      clipboardData: {
        files: [new File(['x'], 'cat.png', { type: 'image/png' })],
        getData: () => ''
      }
    })
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'TkVX'
      )
    )
    expect(screen.getByText('Picture updated')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar('B1') }))
    expect(shown()).not.toBe('data:image/png;base64,TkVX')
  })

  it('Undo re-sends the upload a new picture replaced', async () => {
    const { shown } = renderSection(bot({ avatar: 'upload:v1' }))
    await waitFor(() => expect(shown()).toBe('data:image/png;base64,UE5H'))
    fireEvent.drop(screen.getByRole('dialog'), {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['x'], 'cat.png', { type: 'image/png' })],
        getData: () => ''
      }
    })
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'TkVX'
      )
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
    expect(shown()).toBe('data:image/png;base64,UE5H')
  })

  it('Undo puts back an upload whose bytes were still loading when the new picture came in', async () => {
    let finishRead: (png: string) => void = () => {}
    mocks.readBotAvatarPng.mockImplementation(
      () => new Promise<string>((resolve) => (finishRead = resolve))
    )
    renderSection(bot({ avatar: 'upload:v1' }))
    fireEvent.paste(screen.getByRole('dialog'), {
      clipboardData: {
        files: [new File(['x'], 'cat.png', { type: 'image/png' })],
        getData: () => ''
      }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    // The new upload waits for the old bytes, so it can't overwrite them first.
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()

    finishRead('UE5H')
    await waitFor(() => expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(2))
    expect(mocks.uploadBotAvatar.mock.calls.map((call) => call[1])).toEqual(['TkVX', 'UE5H'])
    mocks.readBotAvatarPng.mockImplementation(async () => 'UE5H')
  })

  it('a pending Undo never overrides a picture chosen after it', async () => {
    let finishRead: (png: string) => void = () => {}
    mocks.readBotAvatarPng.mockImplementation(
      () => new Promise<string>((resolve) => (finishRead = resolve))
    )
    const { update, step, announced } = renderSection(bot({ avatar: 'upload:v1' }))
    fireEvent.paste(screen.getByRole('dialog'), {
      clipboardData: {
        files: [new File(['x'], 'cat.png', { type: 'image/png' })],
        getData: () => ''
      }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    step('Next picture')
    await waitFor(() => expect(update).toHaveBeenCalledWith({ avatar: mascotAvatar('A1') }))

    await act(async () => {
      finishRead('UE5H')
    })
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot-1' }),
      'UE5H'
    )
    expect(announced()).toBe('Mascot 1 of 19')
    mocks.readBotAvatarPng.mockImplementation(async () => 'UE5H')
  })

  it('sends an uploaded image as the bot picture', async () => {
    renderSection(bot())
    const input = document.querySelector('input[type="file"]')
    if (!input) {
      throw new Error('no file input')
    }
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] }
    })
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'TkVX'
      )
    )
  })
})

describe('BotAgentSettings', () => {
  it('asks before switching, says what carries over, then starts the Home Chat on the new agent', async () => {
    const { update } = renderSection(bot())

    await act(async () => mocks.picked.agent?.('codex'))

    const asked = mocks.confirm.mock.calls[0]?.[0]
    expect(asked).toMatchObject({
      title: 'Switch Scout to Codex?',
      description:
        "Scout's Home Chat starts fresh on Codex. The current conversation stays in history.",
      confirmLabel: 'Switch to Codex'
    })
    render(<>{asked?.details}</>)
    expect(screen.getByText('Kept: soul, memory, automations, connectors')).toBeTruthy()
    expect(screen.getByText('Not kept: the current conversation')).toBeTruthy()
    expect(
      screen.getByText('Slack threads already running stay on Claude Code until they finish')
    ).toBeTruthy()
    expect(update).toHaveBeenCalledWith({ agent: 'codex', launch: null })
    expect(mocks.openBotChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }))
  })

  it("saves a model picked for the bot's own agent without asking or restarting its Home Chat", async () => {
    const { update } = renderSection(bot())

    await act(async () => mocks.picked.agent?.('claude', { model: 'opus' }))

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({ launch: { model: 'opus' } })
    expect(mocks.openBotChat).not.toHaveBeenCalled()
  })

  it('clears a saved model when the owner goes back to the chat defaults', async () => {
    const { update } = renderSection(bot({ launch: { model: 'opus' } }))

    await act(async () => mocks.picked.agent?.('claude'))

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({ launch: null })
  })

  it('keeps the agent when the owner cancels', async () => {
    mocks.confirm.mockResolvedValueOnce(false)
    const { update } = renderSection(bot())

    await act(async () => mocks.picked.agent?.('codex'))

    expect(update).not.toHaveBeenCalled()
    expect(mocks.openBotChat).not.toHaveBeenCalled()
  })
})
