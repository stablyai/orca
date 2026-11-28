// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import type { Bot } from '../../../../../shared/bot-types'
import type { TeamShareSuggestion } from './bot-team-share-people'
import { BotTeamShareDialog } from './BotTeamShareDialog'
import { useTeamShareClose } from './use-team-share-close'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog reads only these fields.
const bot = { id: 'b1', name: 'Ada', hostId: 'local', members: [] } as unknown as Bot
const DANA: TeamShareSuggestion = { kind: 'invite', key: 'dana@acme.co', email: 'dana@acme.co' }

function Harness({
  onClose,
  sharing
}: {
  onClose: () => void
  sharing: boolean
}): React.JSX.Element {
  const [staged, setStaged] = useState<TeamShareSuggestion[]>([DANA])
  const close = useTeamShareClose(staged, '', onClose, sharing)
  return (
    <BotTeamShareDialog
      bot={bot}
      hostName="this computer"
      owner={null}
      people={[]}
      othersListed={false}
      query=""
      onQueryChange={() => {}}
      suggestions={null}
      staged={staged}
      onStage={() => {}}
      onUnstage={() => {}}
      onShare={() => {}}
      onCancelStaged={() => setStaged([])}
      onRemove={() => {}}
      onResend={() => {}}
      onShareAgain={() => {}}
      onClose={close}
    />
  )
}

function show(sharing = false): ReturnType<typeof vi.fn> {
  const onClose = vi.fn()
  render(
    <ConfirmationDialogProvider>
      <Harness onClose={onClose} sharing={sharing} />
    </ConfirmationDialogProvider>
  )
  return onClose
}

afterEach(cleanup)

describe('closing the Share dialog with picks not shared', () => {
  it('asks first: Keep editing keeps the picks, Discard closes', async () => {
    const onClose = show()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await screen.findByText('dana@acme.co won’t get access.')
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByText('Keep editing')).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Remove dana@acme.co' })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('Cancel clears the picks without asking, and then closing never asks', async () => {
    const onClose = show()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Keep editing')).toBeNull()
  })

  it('never closes or asks while Share is saving, so its confirmations cannot close it', async () => {
    const onClose = show(true)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Keep editing')).toBeNull()
  })
})
