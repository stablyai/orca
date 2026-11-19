// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parseBotAvatar, PICKABLE_BOT_MASCOT_IDS } from '../../../../shared/bot-avatar'
import { BOT_MASCOT_URLS } from './bot-mascots'
import type { Bot } from '../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({
  createBot: vi.fn(),
  uploadBotAvatar: vi.fn(),
  openBotHomeTab: vi.fn(async () => true),
  agentChoices: vi.fn((): string[] => ['claude', 'codex']),
  squareAvatarPng: vi.fn(async (_blob: Blob) => 'UE5H')
}))
vi.mock('@/lib/bot-catalog', () => ({
  createBot: mocks.createBot,
  uploadBotAvatar: mocks.uploadBotAvatar,
  openBotHomeTab: mocks.openBotHomeTab,
  readBotAvatarPng: vi.fn(async () => null),
  useHostBots: () => []
}))
vi.mock('./bot-avatar-upload', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  squareAvatarPng: mocks.squareAvatarPng
}))
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
      onClick={() =>
        onChange({
          agent: value.agent,
          launch: { model: 'opus', options: { effort: 'high' } },
          permissionMode: 'full-access'
        })
      }
    >
      {`Agent ${value.agent}`}
    </button>
  )
}))

import { NewBotDialog } from './NewBotDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.squareAvatarPng.mockImplementation(async () => 'UE5H')
})

const created: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
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

function renderDialog() {
  render(
    <TooltipProvider>
      <NewBotDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} />
    </TooltipProvider>
  )
  const picture = (): string | null =>
    document.querySelector('[role="dialog"] [data-position="current"] img')?.getAttribute('src') ??
    null
  const announced = (): string | null =>
    screen.getByRole('group', { name: 'Picture' }).querySelector('[aria-live]')?.textContent ?? null
  const submit = async (): Promise<void> => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }))
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalled())
  }
  return { picture, announced, submit }
}

function chooseUpload(): void {
  const input = document.querySelector('input[type="file"]')
  if (!input) {
    throw new Error('no file input')
  }
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] }
  })
}

describe('NewBotDialog picture', () => {
  it('opens on a mascot, steps through them, and creates the bot with the one shown', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { picture, announced, submit } = renderDialog()
    const first = picture()
    expect(first).toBeTruthy()
    expect(announced()).toMatch(new RegExp(`^Mascot \\d+ of ${PICKABLE_BOT_MASCOT_IDS.length}$`))

    fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))
    const next = picture()
    expect(next).not.toBe(first)
    fireEvent.keyDown(screen.getByRole('group', { name: 'Picture' }), { key: 'ArrowLeft' })
    expect(picture()).toBe(first)
    fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))

    await submit()
    const avatar = mocks.createBot.mock.calls[0]?.[1].avatar
    const parsed = parseBotAvatar(avatar)
    expect(parsed?.kind === 'mascot' && BOT_MASCOT_URLS[parsed.id]).toBe(next)
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it('shows an uploaded image and saves it to the new bot', async () => {
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { picture, announced, submit } = renderDialog()
    const mascot = picture()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    chooseUpload()
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    expect(announced()).toBe('Your image')

    await submit()
    // The mascot it was chosen from stays the fallback if the upload is refused.
    const avatar = parseBotAvatar(mocks.createBot.mock.calls[0]?.[1].avatar)
    expect(avatar?.kind === 'mascot' && BOT_MASCOT_URLS[avatar.id]).toBe(mascot)
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
  })

  it('keeps a mascot when the owner moves off the uploaded image', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { picture, submit } = renderDialog()
    chooseUpload()
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }))

    await submit()
    expect(parseBotAvatar(mocks.createBot.mock.calls[0]?.[1].avatar)?.kind).toBe('mascot')
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })
})

describe('NewBotDialog picture intake', () => {
  const png = (): File => new File(['x'], 'cat.png', { type: 'image/png' })
  const transfer = (data: {
    files?: File[]
    text?: string
    uriList?: string
    types?: string[]
  }) => ({
    files: data.files ?? [],
    types:
      data.types ?? (data.files ? ['Files'] : data.uriList ? ['text/uri-list'] : ['text/plain']),
    getData: (type: string) =>
      type === 'text/uri-list'
        ? (data.uriList ?? '')
        : type === 'text/plain'
          ? (data.text ?? '')
          : ''
  })
  const line = (): string =>
    screen.getByRole('button', { name: 'Previous picture' }).closest('[role="group"]')
      ?.nextElementSibling?.textContent ?? ''

  it('takes pasted image data from anywhere in the dialog, the Name field included', async () => {
    const { picture } = renderDialog()
    const taken = fireEvent.paste(screen.getByLabelText('Name'), {
      clipboardData: transfer({ files: [png()] })
    })

    expect(taken).toBe(false)
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
  })

  it.each(['Release captain', 'https://images.example.com/cat.png'])(
    'leaves a paste of %s as text',
    (text) => {
      const { picture } = renderDialog()
      const mascot = picture()
      const pasted = fireEvent.paste(screen.getByLabelText('Name'), {
        clipboardData: transfer({ text })
      })

      expect(pasted).toBe(true)
      expect(picture()).toBe(mascot)
    }
  )

  it('shows the drop target while a file is dragged over, then takes the dropped image', async () => {
    const { picture } = renderDialog()
    const dialog = screen.getByRole('dialog')
    fireEvent.dragEnter(dialog, { dataTransfer: transfer({ files: [], types: ['Files'] }) })

    expect(line()).toBe('Drop to use this image')
    expect(screen.getByText('Drop to use')).toBeTruthy()
    fireEvent.drop(dialog, { dataTransfer: transfer({ files: [png()] }) })
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    expect(line()).toBe('Upload, drop, or paste an image')
  })

  it('ignores a link dragged in from a browser', async () => {
    const { picture } = renderDialog()
    const mascot = picture()
    const dialog = screen.getByRole('dialog')
    const link = transfer({ uriList: 'https://cdn.example.com/a.png' })
    fireEvent.dragEnter(dialog, { dataTransfer: link })
    expect(line()).toBe('Upload, drop, or paste an image')
    expect(fireEvent.drop(dialog, { dataTransfer: link })).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(picture()).toBe(mascot)
    expect(mocks.squareAvatarPng).not.toHaveBeenCalled()
  })

  it.each([
    [
      'too small',
      () => new File(['x'], 'tiny.png', { type: 'image/png' }),
      'Too small. Use an image at least 128 px.'
    ],
    [
      'over 10 MB',
      () => new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
      'That image is over 10 MB.'
    ],
    [
      'an SVG',
      () => new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
      "Orca can't read that image. Try PNG or JPEG."
    ],
    [
      'a PDF',
      () => new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }),
      "Orca can't read that image. Try PNG or JPEG."
    ]
  ])('refuses a dropped file that is %s', async (name, file, message) => {
    if (name === 'too small') {
      mocks.squareAvatarPng.mockRejectedValueOnce(new Error('bot_avatar_too_small'))
    }
    const { picture } = renderDialog()
    const mascot = picture()
    fireEvent.drop(screen.getByRole('dialog'), { dataTransfer: transfer({ files: [file()] }) })

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', message)
    expect(picture()).toBe(mascot)
  })
})

describe('NewBotDialog agent', () => {
  it('starts on the first agent this computer has when Claude Code is not one', async () => {
    mocks.agentChoices.mockReturnValue(['grok', 'omp'])
    mocks.createBot.mockResolvedValue(created)
    const { submit } = renderDialog()

    const change = screen.getByRole('button', { name: /Change$/ })
    expect(change.textContent).toContain('Grok')
    fireEvent.click(change)
    expect(screen.getByRole('button', { name: 'Agent grok' })).toBeTruthy()
    expect(screen.getByText('Where the bot runs.')).toBeTruthy()
    await submit()
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({ agent: 'grok' })
    expect(mocks.createBot.mock.calls[0]?.[1]).not.toHaveProperty('launch')
  })

  it('creates the bot on the model, effort and permission picked for its agent', async () => {
    mocks.agentChoices.mockReturnValue(['claude', 'codex'])
    mocks.createBot.mockResolvedValue(created)
    const { submit } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: /Change$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Agent claude' }))
    expect(screen.getByText(/Runs on/).textContent).toContain('high')
    await submit()
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({
      agent: 'claude',
      launch: { model: 'opus', options: { effort: 'high' } },
      permissionMode: 'full-access'
    })
  })

  it('offers no Create while no agent a bot can be is known on this computer', () => {
    mocks.agentChoices.mockReturnValue([])
    renderDialog()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })

    expect(screen.getByRole('button', { name: 'Create bot' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('NewBotDialog after Create', () => {
  it('closes once the bot exists, while its page is still opening', async () => {
    mocks.agentChoices.mockReturnValue(['claude', 'codex'])
    mocks.createBot.mockResolvedValueOnce(created)
    let finishOpening: (opened: boolean) => void = () => {}
    mocks.openBotHomeTab.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (finishOpening = resolve))
    )
    const onOpenChange = vi.fn()
    const onCreated = vi.fn()
    render(
      <TooltipProvider>
        <NewBotDialog open onOpenChange={onOpenChange} onCreated={onCreated} />
      </TooltipProvider>
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, created))
    expect(onCreated).not.toHaveBeenCalled()
    finishOpening(true)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
  })
})

describe('NewBotDialog keyboard', () => {
  it('opens with the name focused, and ⌘↩ creates from the purpose line', async () => {
    mocks.createBot.mockResolvedValue(created)
    renderDialog()
    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(document.activeElement).toBe(name))
    fireEvent.change(name, { target: { value: 'Reviewer' } })
    fireEvent.keyDown(screen.getByLabelText('Purpose'), {
      key: 'Enter',
      ...(navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true })
    })
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalled())
  })
})

describe('NewBotDialog purpose', () => {
  it('seeds SOUL.md with a typed purpose, and no seed without one', async () => {
    mocks.createBot.mockResolvedValue(created)
    const { submit } = renderDialog()
    fireEvent.change(screen.getByLabelText('Purpose'), {
      target: { value: '  Watch app startup time  ' }
    })
    await submit()
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({
      name: 'Reviewer',
      seed: { purpose: 'Watch app startup time' }
    })

    cleanup()
    mocks.createBot.mockClear()
    await renderDialog().submit()
    expect(mocks.createBot.mock.calls[0]?.[1]).not.toHaveProperty('seed')
  })
})
