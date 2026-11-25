// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { refreshAvatarCapability } from './avatar-generation-capability-store'
import { NewBotDialog } from './NewBotDialog'
import { NewBotPurposeField } from './NewBotPurposeField'

vi.mock('@/lib/bot-catalog', () => ({
  createBot: async () => ({ id: 'bot-1', name: 'Pebble', hostId: 'local' }),
  openBotHomeTab: async () => true,
  useHostBots: () => []
}))
vi.mock('./use-bot-agent-choices', () => ({
  useBotAgentMenu: () => ({ model: { state: 'loading' }, choices: ['codex'] })
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function DialogDraft(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <TooltipProvider>
      <button onClick={() => setOpen(true)}>Open new bot</button>
      <NewBotDialog open={open} onOpenChange={setOpen} />
    </TooltipProvider>
  )
}

async function openGenerate(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Change picture' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Previous picture' }))
  return screen.findByRole('textbox', { name: 'Picture description' })
}

async function closePopover(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Picture description' }), { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Picture description' })).toBeNull()
  )
}

it.each(['Close', 'Create'])(
  'keeps a Generate prompt across popover closes and clears it after %s',
  async (action) => {
    vi.stubGlobal('api', {
      avatarGeneration: {
        capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] })
      }
    })
    refreshAvatarCapability()
    render(<DialogDraft />)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Pebble' } })

    fireEvent.change(await openGenerate(), { target: { value: 'a tiny violet robot gardener' } })
    await closePopover()
    expect(await openGenerate()).toHaveProperty('value', 'a tiny violet robot gardener')

    await closePopover()
    fireEvent.click(screen.getByRole('button', { name: action }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Open new bot' }))
    expect(await openGenerate()).toHaveProperty('value', '')
  }
)

it('marks a cleared box over an over-limit proposal purpose as the name marks a missing name', async () => {
  vi.stubGlobal('api', {})
  render(
    <TooltipProvider>
      <NewBotDialog
        open
        onOpenChange={() => {}}
        proposal={{ name: 'Pebble', purpose: 'x'.repeat(1250) }}
      />
    </TooltipProvider>
  )
  const identity = await screen.findByRole('textbox', { name: 'Identity' })
  fireEvent.change(identity, { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: /Create/ }))

  const [name, tooLong] = await screen.findAllByRole('alert')
  expect(tooLong.textContent).toBe('Too long · 1250/1000')
  expect(identity.getAttribute('aria-invalid')).toBe('true')
  expect(identity.getAttribute('aria-describedby')).toBe(tooLong.id)
  // Reads as the name's own reason line.
  expect(tooLong.className).toBe(name.className)
})

it('shows the count from 80% of the limit', () => {
  const field = (value: string) =>
    render(<NewBotPurposeField value={value} tooLong={false} sentLength={0} onChange={() => {}} />)
  field('x'.repeat(799))
  expect(screen.queryByText('799/1000')).toBeNull()
  cleanup()
  field('x'.repeat(800))
  expect(screen.getByText('800/1000')).toBeTruthy()
})
