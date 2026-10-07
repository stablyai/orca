// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { Button } from '@/components/ui/button'
import { PopoverTrigger } from '@/components/ui/popover'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

const CHOICES = [
  { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier reasoning' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'opus', label: 'Opus 4.8' }
]

const settle = (): Promise<void> =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

type ComboboxOptions = { defaultOpen?: boolean; readOnly?: boolean; readOnlyReason?: string | null }
type OnSelect = ReturnType<typeof vi.fn<(value: string) => void>>

function renderCombobox(props: ComboboxOptions = {}): OnSelect {
  const onSelect = vi.fn<(value: string) => void>()
  render(
    <NativeChatModelCombobox
      choices={CHOICES}
      currentValue="opus"
      defaultOpen={props.defaultOpen ?? true}
      readOnly={props.readOnly ?? false}
      readOnlyReason={props.readOnlyReason ?? null}
      onSelect={onSelect}
      renderTrigger={(onKeyDown) => (
        <PopoverTrigger asChild>
          <Button onKeyDown={onKeyDown}>Model</Button>
        </PopoverTrigger>
      )}
    />
  )
  return onSelect
}

/** Renders the picker already open and returns its search field. */
async function openCombobox(
  props: ComboboxOptions = {}
): Promise<{ search: HTMLElement; onSelect: OnSelect }> {
  const onSelect = renderCombobox(props)
  await settle()
  return { search: screen.getByRole('combobox'), onSelect }
}

const listedModels = (): (string | null)[] =>
  screen.queryAllByRole('option').map((option) => option.getAttribute('data-value'))

const highlightedModel = (): string | null =>
  screen.queryByRole('option', { selected: true })?.getAttribute('data-value') ?? null

afterEach(() => cleanup())

describe('NativeChatModelCombobox', () => {
  it('opens with the search focused and the current model highlighted and marked', async () => {
    const { search } = await openCombobox()
    expect(document.activeElement).toBe(search)
    expect(screen.getByRole('combobox', { name: 'Search models…' })).toBe(search)
    expect(listedModels()).toEqual(['gpt-5.5', 'gpt-5.2-codex', 'opus'])
    expect(highlightedModel()).toBe('opus')
    expect(screen.getByRole('option', { current: true }).getAttribute('data-value')).toBe('opus')
  })

  it('focuses the search when the pill is clicked', async () => {
    renderCombobox({ defaultOpen: false })
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('opens with the search focused when ArrowDown is pressed on the pill', async () => {
    renderCombobox({ defaultOpen: false })
    const pill = screen.getByRole('button', { name: 'Model' })
    pill.focus()
    fireEvent.keyDown(pill, { key: 'ArrowDown' })
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('filters by every typed term across label, id and description, in list order', async () => {
    const { search } = await openCombobox()

    fireEvent.change(search, { target: { value: 'gpt' } })
    expect(listedModels()).toEqual(['gpt-5.5', 'gpt-5.2-codex'])
    expect(highlightedModel()).toBe('gpt-5.5')

    fireEvent.change(search, { target: { value: 'GPT codex' } })
    expect(listedModels()).toEqual(['gpt-5.2-codex'])

    fireEvent.change(search, { target: { value: 'frontier' } })
    expect(listedModels()).toEqual(['gpt-5.5'])

    fireEvent.change(search, { target: { value: 'gemini' } })
    expect(listedModels()).toEqual([])
    expect(screen.getByText('No models match your search.')).not.toBeNull()
  })

  it('moves the highlight with the arrows while focus stays in the search', async () => {
    const { search, onSelect } = await openCombobox()
    fireEvent.change(search, { target: { value: 'gpt' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(highlightedModel()).toBe('gpt-5.2-codex')
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(search, { key: 'Enter' })
    await settle()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('gpt-5.2-codex')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('closes on Tab instead of trapping focus in the search', async () => {
    const { search } = await openCombobox()
    fireEvent.keyDown(search, { key: 'Tab' })
    await settle()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('picks a clicked row and closes', async () => {
    const { onSelect } = await openCombobox()
    fireEvent.click(screen.getByRole('option', { name: /GPT-5.2 Codex/ }))
    await settle()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('gpt-5.2-codex')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('lists but does not pick models it cannot set, and says why', async () => {
    const { search, onSelect } = await openCombobox({
      readOnly: true,
      readOnlyReason: 'Set when the session starts.'
    })
    expect(screen.getByText('Set when the session starts.')).not.toBeNull()
    fireEvent.change(search, { target: { value: 'codex' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: /GPT-5.2 Codex/ }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
