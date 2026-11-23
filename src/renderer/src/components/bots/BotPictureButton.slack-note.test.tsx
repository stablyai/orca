// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../shared/bot-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { BotPictureCustom, BotPictureValue } from './BotPicturePicker'

vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true, useBotHostHas: () => true }))

import { BotPictureButton } from './BotPictureButton'
import type { useBotPictureSetting } from '../settings/bots/use-bot-picture-setting'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the button reads only these fields.
const BOT = {
  id: 'b1',
  hostId: 'local',
  name: 'Scout',
  avatar: mascotAvatar('M1'),
  slack: { teamId: 'T1' }
} as unknown as Bot

const UPLOAD: BotPictureCustom = {
  src: 'data:image/png;base64,AAAA',
  fallback: '',
  after: 0,
  description: 'Your image'
}

afterEach(cleanup)

function openPicker(value: BotPictureValue, custom: BotPictureCustom | null): void {
  const picture: ReturnType<typeof useBotPictureSetting> = {
    value,
    custom,
    pick: () => {},
    upload: () => {},
    undo: () => {},
    color: null,
    pickColor: () => {},
    outfit: null,
    pickOutfit: () => {}
  }
  render(
    <TooltipProvider>
      <BotPictureButton bot={BOT} picture={picture} avatarClassName="size-12" />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Edit bot picture' })
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
  fireEvent.click(trigger)
}

describe('BotPictureButton Slack note', () => {
  it('names the color and outfit Slack leaves out under a mascot', async () => {
    openPicker({ kind: 'mascot', index: 0 }, null)
    expect(await screen.findByText('Slack gets the picture, not the color or outfit.')).toBeTruthy()
  })

  it('leaves the color and outfit out under an uploaded or generated image', async () => {
    openPicker({ kind: 'custom' }, UPLOAD)
    expect(await screen.findByText("Changes your bot's picture in Slack too.")).toBeTruthy()
    expect(screen.queryByText(/not the color/)).toBeNull()
  })
})
