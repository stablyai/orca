// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { AgentPostPasteSubmitInputControl } from './AgentPostPasteSubmitInputControl'

afterEach(cleanup)

it('keeps the selected input inert and saves a different selection', async () => {
  const onSave = vi.fn()
  render(
    <TooltipProvider>
      <AgentPostPasteSubmitInputControl value="enter" onSave={onSave} />
    </TooltipProvider>
  )

  fireEvent.click(screen.getByRole('radio', { name: 'Press Enter' }))
  expect(onSave).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('radio', { name: 'Press Ctrl+Enter' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith('ctrl-enter'))
})

it('keeps the latest selection when an earlier save is still pending', async () => {
  let resolveFirstSave: () => void = () => {
    throw new Error('Expected the first save to be pending.')
  }
  const firstSave = new Promise<void>((resolve) => {
    resolveFirstSave = resolve
  })
  const onSave = vi.fn().mockReturnValueOnce(firstSave).mockResolvedValue(undefined)
  render(
    <TooltipProvider>
      <AgentPostPasteSubmitInputControl value="enter" onSave={onSave} />
    </TooltipProvider>
  )

  fireEvent.click(screen.getByRole('radio', { name: 'Press Ctrl+Enter' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Press Enter' }))

  await waitFor(() =>
    expect(onSave.mock.calls.map(([value]) => value)).toEqual(['ctrl-enter', 'enter'])
  )
  expect(screen.getByRole('radio', { name: 'Press Enter' }).getAttribute('aria-checked')).toBe(
    'true'
  )
  resolveFirstSave()
})

it('returns to the latest persisted value when saving fails', async () => {
  const onSave = vi.fn().mockRejectedValue(new Error('Save failed'))
  render(
    <TooltipProvider>
      <AgentPostPasteSubmitInputControl value="enter" onSave={onSave} />
    </TooltipProvider>
  )

  fireEvent.click(screen.getByRole('radio', { name: 'Press Ctrl+Enter' }))
  await waitFor(() => expect(onSave).toHaveBeenCalledWith('ctrl-enter'))
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Press Enter' }).getAttribute('aria-checked')).toBe(
      'true'
    )
  )
})
