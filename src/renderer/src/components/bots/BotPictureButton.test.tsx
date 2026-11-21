// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { AvatarGenerationResult } from '../../../../shared/avatar-generation/avatar-generation-contract'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  uploadBotAvatar: vi.fn(async () => ({ id: 'b1', hostId: 'local', avatarRevision: 1 }))
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true, useBotHostHas: () => true }))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadBotAvatar: mocks.uploadBotAvatar
}))
// The real crop draws on a canvas, which happy-dom lacks.
vi.mock('./bot-avatar-intake', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avatarPngFromBlob: async () => 'CROPPED'
}))

import { BotPictureButton } from './BotPictureButton'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'
import {
  resetAvatarCapabilityForTest,
  seedAvatarCapabilityForTest
} from './avatar-generation-capability-store'
import { resetAvatarRequestsForTests } from './avatar-generation-requests'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the button reads only these fields.
const BOT = { id: 'b1', hostId: 'local', name: 'Scout', avatar: mascotAvatar('M1') } as Bot

afterEach(() => {
  cleanup()
  resetAvatarRequestsForTests()
  resetAvatarCapabilityForTest()
  Reflect.deleteProperty(window, 'api')
  vi.clearAllMocks()
})

/** Renders the button, asks for a picture and closes the picker; the run's outcome is the test's. */
async function generateThenClose(uploadsSoFar: () => number = () => 0) {
  let settle: (outcome: AvatarGenerationResult) => void = () => {}
  Reflect.set(window, 'api', {
    avatarGeneration: {
      capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] }),
      generate: () => new Promise<AvatarGenerationResult>((done) => (settle = done)),
      cancel: async () => {}
    }
  })
  seedAvatarCapabilityForTest([{ agent: 'codex', status: 'ready' }])
  const picture: ReturnType<typeof useBotPictureSetting> = {
    value: { kind: 'mascot', index: 0 },
    custom: null,
    pick: () => {},
    upload: () => {},
    undo: () => {},
    color: null,
    pickColor: () => {},
    beginIntake: () => () => {},
    uploads: uploadsSoFar
  }
  render(
    <TooltipProvider>
      <BotPictureButton bot={BOT} picture={picture} avatarClassName="size-12" />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Edit bot picture' })
  const togglePicker = (): void => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)
  }
  togglePicker()
  fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
  const box = await screen.findByRole('textbox', { name: 'Picture description' })
  fireEvent.change(box, { target: { value: 'a fox' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await screen.findByRole('button', { name: 'Cancel generating' })
  togglePicker()
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Picture description' })).toBeNull()
  )
  return { settle: async (outcome: AvatarGenerationResult) => settle(outcome), togglePicker }
}

describe('BotPictureButton, a run going on with the picker closed', () => {
  it('says so in a toast when it fails, and reopens on the failed run', async () => {
    const { settle, togglePicker } = await generateThenClose()

    await settle({ ok: false, error: 'timed-out', agent: 'codex' })

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Couldn't generate a picture for Scout.")
    )
    // Reopened on the Generate face, where the error is kept.
    togglePicker()
    expect(await screen.findByRole('textbox', { name: 'Picture description' })).toBeTruthy()
  })

  it('leaves the slot to a picture uploaded after Generate was asked for', async () => {
    let uploads = 0
    const { settle, togglePicker } = await generateThenClose(() => uploads)
    uploads = 1

    await settle({ ok: true, agent: 'codex', image: { mimeType: 'image/png', base64: 'AAAA' } })
    await waitFor(() => expect(mocks.uploadBotAvatar).toHaveBeenCalled())

    togglePicker()
    await screen.findByRole('button', { name: 'Previous picture' })
    expect(document.querySelector('img[src="data:image/png;base64,CROPPED"]')).toBeNull()
  })
})
