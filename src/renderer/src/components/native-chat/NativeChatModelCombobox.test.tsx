// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { NativeChatModelCombobox } from './NativeChatModelCombobox'

const CHOICES = [
  { value: 'gpt-5.5', label: 'GPT-5.5', description: 'Frontier reasoning' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { value: 'opus', label: 'Opus 4.8' }
]

const settle = (): Promise<void> =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

type ComboboxOptions = { readOnly?: boolean; readOnlyReason?: string | null }
type OnSelect = ReturnType<typeof vi.fn<(value: string) => void>>

/** Renders the model list and returns its search field. */
async function renderCombobox(
  props: ComboboxOptions = {}
): Promise<{ search: HTMLElement; onSelect: OnSelect }> {
  const onSelect = vi.fn<(value: string) => void>()
  render(
    <NativeChatModelCombobox
      choices={CHOICES}
      currentValue="opus"
      readOnly={props.readOnly ?? false}
      readOnlyReason={props.readOnlyReason ?? null}
      busy={false}
      onSelect={onSelect}
    />
  )
  await settle()
  return { search: screen.getByRole('combobox'), onSelect }
}

const listedModels = (): (string | null)[] =>
  screen.queryAllByRole('option').map((option) => option.getAttribute('data-value'))

const highlightedModel = (): string | null =>
  screen.queryByRole('option', { selected: true })?.getAttribute('data-value') ?? null

afterEach(() => cleanup())

describe('NativeChatModelCombobox', () => {
  it('lists the models with the current one highlighted and marked', async () => {
    const { search } = await renderCombobox()
    expect(screen.getByRole('combobox', { name: 'Search models…' })).toBe(search)
    expect(listedModels()).toEqual(['gpt-5.5', 'gpt-5.2-codex', 'opus'])
    expect(highlightedModel()).toBe('opus')
    expect(screen.getByRole('option', { current: true }).getAttribute('data-value')).toBe('opus')
  })

  it('filters by every typed term across label, id and description, in list order', async () => {
    const { search } = await renderCombobox()

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

  it('moves the highlight with the arrows and picks it with Enter', async () => {
    const { search, onSelect } = await renderCombobox()
    fireEvent.change(search, { target: { value: 'gpt' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(highlightedModel()).toBe('gpt-5.2-codex')

    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('gpt-5.2-codex')
  })

  it('picks a clicked row, and sends nothing for the model already in use', async () => {
    const { onSelect } = await renderCombobox()
    fireEvent.click(screen.getByRole('option', { name: /Opus 4.8/ }))
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('option', { name: /GPT-5.2 Codex/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('gpt-5.2-codex')
  })

  it('lists but does not pick models it cannot set, and says why', async () => {
    const { search, onSelect } = await renderCombobox({
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
