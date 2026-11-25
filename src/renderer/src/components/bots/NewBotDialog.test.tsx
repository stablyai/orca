// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { refreshAvatarCapability } from './avatar-generation-capability-store'
import { NewBotDialog } from './NewBotDialog'

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
