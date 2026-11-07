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

afterEach(() => cleanup())

describe('NativeChatModelCombobox', () => {
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
