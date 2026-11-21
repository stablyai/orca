// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { parseBotAvatar } from '../../../../shared/bot-avatar'
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
import {
  resetAvatarCapabilityForTest,
  seedAvatarCapabilityForTest
} from './avatar-generation-capability-store'

afterEach(() => {
  resetAvatarCapabilityForTest()
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
  // The picture the dialog shows, on its Change picture button.
  const picture = (): string | null =>
    screen
      .getByRole('button', { name: 'Change picture' })
      .querySelector('img')
      ?.getAttribute('src') ?? null
  const openPicker = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Change picture' }))
  }
  const submit = async (): Promise<void> => {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(mocks.createBot).toHaveBeenCalled())
  }
  return { picture, openPicker, submit }
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
    const { picture, openPicker, submit } = renderDialog()
    const first = picture()
    expect(first).toBeTruthy()
    openPicker()

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
    const { picture, openPicker, submit } = renderDialog()
    const mascot = picture()
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    chooseUpload()
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))

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
    const { picture, openPicker, submit } = renderDialog()
    openPicker()
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
  const dropTarget = (): HTMLElement | null => screen.queryByText('Drop to use')

  it('takes pasted image data from anywhere in the dialog, the Name field included', async () => {
    const { picture } = renderDialog()
    const taken = fireEvent.paste(screen.getByLabelText('Name'), {
      clipboardData: transfer({ files: [png()] })
    })

    expect(taken).toBe(false)
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
  })

  it('keeps a picture chosen in the popover when it closes before the image is read', async () => {
    let finish: (png: string) => void = () => {}
    mocks.squareAvatarPng.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { picture, openPicker, submit } = renderDialog()
    openPicker()
    chooseUpload()
    openPicker()
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Picture' })).toBeNull())

    finish('UE5H')
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    await submit()
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
  })

  it('keeps the newer picture when an older one, from the other surface, is read last', async () => {
    const finishes: ((png: string) => void)[] = []
    mocks.squareAvatarPng.mockImplementation(
      () => new Promise<string>((resolve) => finishes.push(resolve))
    )
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { picture, openPicker, submit } = renderDialog()
    openPicker()
    fireEvent.paste(screen.getByLabelText('Name'), { clipboardData: transfer({ files: [png()] }) })
    chooseUpload()
    await waitFor(() => expect(finishes).toHaveLength(2))

    finishes[1]?.('QkJCQg')
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,QkJCQg'))
    finishes[0]?.('QUFBQQ')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(picture()).toBe('data:image/png;base64,QkJCQg')
    await submit()
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'QkJCQg'
      )
    )
  })

  it('waits for a picture still being read before Create, then saves that picture', async () => {
    let finish: (png: string) => void = () => {}
    mocks.squareAvatarPng.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { openPicker } = renderDialog()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    openPicker()
    chooseUpload()
    const create = screen.getByRole('button', { name: 'Create' })
    await waitFor(() => expect(create).toHaveProperty('disabled', true))
    const form = screen.getByLabelText('Name').closest('form')
    if (!form) {
      throw new Error('Expected the bot creation form')
    }
    fireEvent.submit(form)
    expect(mocks.createBot).not.toHaveBeenCalled()

    finish('UE5H')
    await waitFor(() => expect(create).toHaveProperty('disabled', false))
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
  })

  it('lets Create go again once a picture it waited for is refused', async () => {
    mocks.squareAvatarPng.mockRejectedValueOnce(new Error('bot_avatar_too_small'))
    renderDialog()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    fireEvent.drop(screen.getByRole('dialog'), { dataTransfer: transfer({ files: [png()] }) })

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', false)
  })

  it('keeps a picture being read when another file is dragged across without a drop', async () => {
    let finish: (png: string) => void = () => {}
    mocks.squareAvatarPng.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve))
    )
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { picture } = renderDialog()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    fireEvent.paste(screen.getByLabelText('Name'), { clipboardData: transfer({ files: [png()] }) })
    const create = screen.getByRole('button', { name: 'Create' })
    await waitFor(() => expect(create).toHaveProperty('disabled', true))
    const dialog = screen.getByRole('dialog')
    fireEvent.dragEnter(dialog, { dataTransfer: transfer({ files: [], types: ['Files'] }) })
    fireEvent.dragLeave(dialog, { dataTransfer: transfer({ files: [], types: ['Files'] }) })

    expect(create).toHaveProperty('disabled', true)
    finish('UE5H')
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
  })

  it('leaves a pasted image URL as text', () => {
    const { picture } = renderDialog()
    const mascot = picture()
    const pasted = fireEvent.paste(screen.getByLabelText('Name'), {
      clipboardData: transfer({ text: 'https://images.example.com/cat.png' })
    })

    expect(pasted).toBe(true)
    expect(picture()).toBe(mascot)
  })

  it('shows the drop target while a file is dragged over, then takes the dropped image', async () => {
    const { picture } = renderDialog()
    const dialog = screen.getByRole('dialog')
    fireEvent.dragEnter(dialog, { dataTransfer: transfer({ files: [], types: ['Files'] }) })

    expect(dropTarget()).toBeTruthy()
    fireEvent.drop(dialog, { dataTransfer: transfer({ files: [png()] }) })
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    expect(dropTarget()).toBeNull()
  })

  it('ignores a link dragged in from a browser', async () => {
    const { picture } = renderDialog()
    const mascot = picture()
    const dialog = screen.getByRole('dialog')
    const link = transfer({ uriList: 'https://cdn.example.com/a.png' })
    fireEvent.dragEnter(dialog, { dataTransfer: link })
    expect(dropTarget()).toBeNull()
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
  it('does not create a bot when the selected computer has no chat agent', () => {
    mocks.agentChoices.mockReturnValue([])
    renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    const form = screen.getByLabelText('Name').closest('form')
    if (!form) {
      throw new Error('Expected the bot creation form')
    }
    fireEvent.submit(form)

    expect(mocks.createBot).not.toHaveBeenCalled()
  })

  it('starts on the first agent this computer has when Claude Code is not one', async () => {
    mocks.agentChoices.mockReturnValue(['grok', 'omp'])
    mocks.createBot.mockResolvedValue(created)
    const { submit } = renderDialog()

    await submit()
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({ agent: 'grok' })
    expect(mocks.createBot.mock.calls[0]?.[1]).not.toHaveProperty('launch')
  })

  it('creates the bot on the model, effort and permission picked for its agent', async () => {
    mocks.agentChoices.mockReturnValue(['claude', 'codex'])
    mocks.createBot.mockResolvedValue(created)
    const { submit } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Agent claude' }))
    await submit()
    expect(mocks.createBot.mock.calls[0]?.[1]).toMatchObject({
      agent: 'claude',
      launch: { model: 'opus', options: { effort: 'high' } },
      permissionMode: 'full-access'
    })
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
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false, created))
    expect(onCreated).not.toHaveBeenCalled()
    finishOpening(true)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
  })
})

describe('NewBotDialog keyboard', () => {
  it('keeps Create off until the bot has a name', () => {
    renderDialog()
    const create = screen.getByRole('button', { name: 'Create' })
    expect(create).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } })
    expect(create).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    expect(create).toHaveProperty('disabled', false)
  })

  it('opens with the name focused, and ⌘↩ creates from the identity box', async () => {
    mocks.createBot.mockResolvedValue(created)
    renderDialog()
    const name = screen.getByLabelText('Name')
    await waitFor(() => expect(document.activeElement).toBe(name))
    fireEvent.change(name, { target: { value: 'Reviewer' } })
    fireEvent.keyDown(screen.getByLabelText('Identity'), {
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
    fireEvent.change(screen.getByLabelText('Identity'), {
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

describe('NewBotDialog Generate and an upload', () => {
  const GENERATED = 'R0VO'
  let finishGenerate: () => void = () => {}
  let finishUpload: (png: string) => void = () => {}

  function stubGeneration(): void {
    Reflect.set(window, 'api', {
      avatarGeneration: {
        capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] }),
        generate: () =>
          new Promise((resolve) => {
            finishGenerate = () =>
              resolve({
                ok: true,
                agent: 'codex',
                image: { mimeType: 'image/png', base64: 'AAAA' }
              })
          }),
        cancel: async () => {}
      }
    })
    seedAvatarCapabilityForTest([{ agent: 'codex', status: 'ready' }])
    // The upload is read slowly; the generated picture at once.
    mocks.squareAvatarPng.mockImplementation((blob: Blob) =>
      blob instanceof File
        ? new Promise<string>((resolve) => (finishUpload = resolve))
        : Promise.resolve(GENERATED)
    )
  }

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  // Upload A, then ask for a picture B: B is the newer choice whichever finishes first.
  async function uploadThenGenerate(): Promise<ReturnType<typeof renderDialog>> {
    stubGeneration()
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const dialog = renderDialog()
    dialog.openPicker()
    chooseUpload()
    fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
    const box = await screen.findByRole('textbox', { name: 'Picture description' })
    fireEvent.change(box, { target: { value: 'a fox' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    return dialog
  }

  it.each([
    ['the same image again', 'UE5H', 'UE5H'],
    ['a different image', 'UE5H', 'QkJCQg']
  ])(
    'leaves Generate for a pasted %s while a picture is on its way',
    async (_name, first, second) => {
      stubGeneration()
      mocks.createBot.mockResolvedValue(created)
      mocks.uploadBotAvatar.mockResolvedValue(created)
      const { picture, openPicker, submit } = renderDialog()
      const paste = (): void => {
        fireEvent.paste(screen.getByLabelText('Name'), {
          clipboardData: {
            files: [new File(['x'], 'cat.png', { type: 'image/png' })],
            types: ['Files'],
            getData: () => ''
          }
        })
      }
      paste()
      finishUpload(first)
      await waitFor(() => expect(picture()).toBe(`data:image/png;base64,${first}`))
      openPicker()
      // The pasted picture holds the Generate slot; clicking it opens its description.
      fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }))
      const box = await screen.findByRole('textbox', { name: 'Picture description' })
      fireEvent.change(box, { target: { value: 'a fox' } })
      fireEvent.keyDown(box, { key: 'Enter' })

      // Create comes back once the pasted picture has landed, the same image or not.
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
      const create = screen.getByRole('button', { name: 'Create' })
      paste()
      await waitFor(() => expect(create).toHaveProperty('disabled', true))
      finishUpload(second)
      await waitFor(() => expect(create).toHaveProperty('disabled', false))
      expect(picture()).toBe(`data:image/png;base64,${second}`)
      finishGenerate()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(picture()).toBe(`data:image/png;base64,${second}`)
      await submit()
      await waitFor(() =>
        expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'bot-1' }),
          second
        )
      )
    }
  )

  describe('a picture chosen while an older upload is still read', () => {
    // A slow upload into the open picker; the tile and the saved avatar are checked after it lands.
    async function slowUploadThen(choose: () => Promise<void> | void): Promise<{
      shown: string | null
      picture: () => string | null
      submit: () => Promise<void>
    }> {
      const { picture, submit } = dialogRef.current ?? renderDialog()
      chooseUpload()
      await choose()
      const shown = picture()
      finishUpload('U0xPVw')
      await new Promise((resolve) => setTimeout(resolve, 0))
      return { shown, picture, submit }
    }
    const dialogRef: { current: ReturnType<typeof renderDialog> | null } = { current: null }

    beforeEach(() => {
      stubGeneration()
      mocks.createBot.mockResolvedValue(created)
      mocks.uploadBotAvatar.mockResolvedValue(created)
      dialogRef.current = null
    })

    it('keeps a mascot', async () => {
      dialogRef.current = renderDialog()
      dialogRef.current.openPicker()
      await screen.findByRole('button', { name: 'Next picture' })
      const { shown, picture, submit } = await slowUploadThen(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))
      })

      expect(shown).not.toBe('data:image/png;base64,U0xPVw')
      expect(picture()).toBe(shown)
      await submit()
      expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
    })

    it('keeps an earlier upload chosen again', async () => {
      dialogRef.current = renderDialog()
      dialogRef.current.openPicker()
      chooseUpload()
      finishUpload('RUFSTA')
      await waitFor(() => expect(dialogRef.current?.picture()).toBe('data:image/png;base64,RUFSTA'))
      fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))
      const { picture, submit } = await slowUploadThen(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }))
      })

      expect(picture()).toBe('data:image/png;base64,RUFSTA')
      await submit()
      await waitFor(() =>
        expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'bot-1' }),
          'RUFSTA'
        )
      )
    })

    it('keeps a generated picture chosen again', async () => {
      dialogRef.current = renderDialog()
      dialogRef.current.openPicker()
      fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
      const box = await screen.findByRole('textbox', { name: 'Picture description' })
      fireEvent.change(box, { target: { value: 'a fox' } })
      fireEvent.keyDown(box, { key: 'Enter' })
      finishGenerate()
      await waitFor(() =>
        expect(dialogRef.current?.picture()).toBe(`data:image/png;base64,${GENERATED}`)
      )
      fireEvent.click(screen.getByRole('button', { name: 'Next picture' }))
      const { picture, submit } = await slowUploadThen(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }))
      })

      expect(picture()).toBe(`data:image/png;base64,${GENERATED}`)
      await submit()
      await waitFor(() =>
        expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'bot-1' }),
          GENERATED
        )
      )
    })

    it('still lands when only the empty Generate face was browsed', async () => {
      dialogRef.current = renderDialog()
      dialogRef.current.openPicker()
      await screen.findByRole('button', { name: 'Previous picture' })
      const { picture, submit } = await slowUploadThen(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }))
        await screen.findByRole('textbox', { name: 'Picture description' })
      })

      await waitFor(() => expect(picture()).toBe('data:image/png;base64,U0xPVw'))
      await submit()
      await waitFor(() =>
        expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'bot-1' }),
          'U0xPVw'
        )
      )
    })
  })

  it('keeps the same image pasted again when it and an older Generate land in one render', async () => {
    stubGeneration()
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { picture, openPicker, submit } = renderDialog()
    const paste = (): void => {
      fireEvent.paste(screen.getByLabelText('Name'), {
        clipboardData: {
          files: [new File(['x'], 'cat.png', { type: 'image/png' })],
          types: ['Files'],
          getData: () => ''
        }
      })
    }
    paste()
    finishUpload('UE5H')
    await waitFor(() => expect(picture()).toBe('data:image/png;base64,UE5H'))
    openPicker()
    // The pasted picture holds the Generate slot; clicking it opens its description.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit description' }))
    const box = await screen.findByRole('textbox', { name: 'Picture description' })
    fireEvent.change(box, { target: { value: 'a fox' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    paste()

    // Both settle before React renders again.
    finishUpload('UE5H')
    finishGenerate()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(picture()).toBe('data:image/png;base64,UE5H')
    await submit()
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
  })

  it('keeps an upload being read when a Generate prompt is turned away', async () => {
    stubGeneration()
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue(created)
    const { picture, openPicker } = renderDialog()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
    const create = screen.getByRole('button', { name: 'Create' })
    openPicker()
    chooseUpload()
    fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
    const box = await screen.findByRole('textbox', { name: 'Picture description' })
    fireEvent.change(box, { target: { value: 'a picture of me' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(create).toHaveProperty('disabled', true)
    finishUpload('UE5H')
    await waitFor(() => expect(create).toHaveProperty('disabled', false))
    expect(picture()).toBe('data:image/png;base64,UE5H')
    fireEvent.click(create)
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        'UE5H'
      )
    )
  })

  async function generateThenClose(): Promise<ReturnType<typeof renderDialog>> {
    stubGeneration()
    mocks.createBot.mockResolvedValue(created)
    mocks.uploadBotAvatar.mockResolvedValue({ ...created, avatar: 'upload:abc', avatarRevision: 1 })
    const dialog = renderDialog()
    dialog.openPicker()
    fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
    const box = await screen.findByRole('textbox', { name: 'Picture description' })
    fireEvent.change(box, { target: { value: 'a fox' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByText('Close anytime')).toBeTruthy()
    // The trigger closes the popover again; the run goes on.
    fireEvent.click(screen.getByRole('button', { name: 'Change picture' }))
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Picture description' })).toBeNull()
    )
    return dialog
  }

  it('keeps generating with the picker closed, and the picture made becomes the one shown', async () => {
    const { picture, openPicker } = await generateThenClose()
    const cancel = vi.spyOn(window.api.avatarGeneration, 'cancel')

    finishGenerate()

    await waitFor(() => expect(picture()).toBe(`data:image/png;base64,${GENERATED}`))
    expect(cancel).not.toHaveBeenCalled()
    openPicker()
    expect(await screen.findByRole('button', { name: 'Edit description' })).toBeTruthy()
  })

  it('reopens on the run still going', async () => {
    const { openPicker } = await generateThenClose()
    openPicker()
    expect(await screen.findByRole('button', { name: 'Cancel generating' })).toBeTruthy()
  })

  it('uploads a picture that lands after Create to the bot made, behind its revision', async () => {
    const { submit } = await generateThenClose()
    await submit()
    expect(mocks.createBot.mock.calls[0]?.[1].avatar).toMatch(/^mascot:/)
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()

    finishGenerate()

    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        { hostId: 'local', id: 'bot-1' },
        GENERATED,
        { expectedAvatarRevision: 0 }
      )
    )
    expect(mocks.uploadBotAvatar).toHaveBeenCalledTimes(1)
  })

  it('drops a picture still being made for a mascot picked after Generate, at Create', async () => {
    const { openPicker, submit } = await generateThenClose()
    const cancel = vi.spyOn(window.api.avatarGeneration, 'cancel')
    openPicker()
    fireEvent.click(await screen.findByRole('button', { name: 'Next picture' }))
    await submit()
    finishGenerate()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancel).toHaveBeenCalled()
    expect(mocks.uploadBotAvatar).not.toHaveBeenCalled()
  })

  it.each([
    ['the upload finishes first', ['upload', 'generate']],
    ['the upload finishes last', ['generate', 'upload']]
  ])('saves the generated picture when %s', async (_name, order) => {
    const { picture, submit } = await uploadThenGenerate()
    for (const step of order) {
      if (step === 'upload') {
        finishUpload('QUFBQQ')
      } else {
        finishGenerate()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await waitFor(() => expect(picture()).toBe(`data:image/png;base64,${GENERATED}`))
    await submit()
    await waitFor(() =>
      expect(mocks.uploadBotAvatar).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-1' }),
        GENERATED
      )
    )
  })
})

describe('NewBotDialog from a template-backed offer', () => {
  it('lists the workspaces it takes over, and fills the identity from the purpose when it has no lines', () => {
    render(
      <TooltipProvider>
        <NewBotDialog
          open
          onOpenChange={vi.fn()}
          proposal={{
            name: 'Reviewer',
            purpose: 'Reviews the payments service pull requests.',
            templateId: 'pr-review',
            worktrees: [{ id: 'w1', name: 'payments-refactor' }]
          }}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Takes over')).toBeTruthy()
    expect(screen.getByText('payments-refactor')).toBeTruthy()
    expect(screen.getByLabelText('Identity')).toHaveProperty(
      'value',
      'Reviews the payments service pull requests.'
    )
  })
})
