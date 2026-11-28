// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentCopyIdentityFields } from './AgentCopyIdentityFields'

vi.mock('@/lib/bot-catalog', () => ({ useBots: () => [] }))
vi.mock('@/lib/bot-catalog-snapshot', () => ({ readBotHostListed: () => true }))

afterEach(cleanup)

const copy = { id: 'claude.code-mode', name: 'Claude Code Mode', agent: 'claude' as const }

function setup() {
  const onChangeId = vi.fn(async () => {})
  const view = render(
    <AgentCopyIdentityFields
      copy={copy}
      taken={['claude.taken']}
      onRename={vi.fn(async () => {})}
      onChangeId={onChangeId}
    />
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Copy ID textbox is an input.
  const input = view.getByRole('textbox', { name: 'Copy ID' }) as HTMLInputElement
  return { ...view, input, onChangeId }
}

describe("an agent copy's ID field", () => {
  it('holds the whole id in one input, so it selects and copies as one string', () => {
    const { input, container } = setup()
    expect(input.value).toBe('claude.code-mode')
    fireEvent.doubleClick(input)
    expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe(
      'claude.code-mode'
    )
    // The prefix shows greyed, apart from the editable suffix.
    const shadow = container.querySelector('[data-agent-copy-id-shadow]')
    expect(shadow?.children[0]?.textContent).toBe('claude.')
    expect(shadow?.children[0]?.className).toContain('text-muted-foreground')
    expect(shadow?.children[1]?.textContent).toBe('code-mode')
  })

  it('keeps the prefix when the whole id is typed over', async () => {
    const { input, onChangeId } = setup()
    await userEvent.type(input, 'fast', {
      initialSelectionStart: 0,
      initialSelectionEnd: input.value.length
    })
    expect(input.value).toBe('claude.fast')
    fireEvent.blur(input)
    expect(onChangeId).toHaveBeenCalledWith('claude.fast')
  })

  it('keeps the prefix when backspace reaches it', async () => {
    const { input } = setup()
    await userEvent.type(input, '{Backspace}', {
      initialSelectionStart: 'claude.'.length,
      initialSelectionEnd: 'claude.'.length
    })
    expect(input.value).toBe('claude.code-mode')
  })

  it('types after the prefix once backspace has hit it on an empty suffix', async () => {
    const { input } = setup()
    // Delete the whole suffix, then press Backspace into the prefix a few more times.
    await userEvent.type(
      input,
      `${'{Backspace}'.repeat('code-mode'.length)}{Backspace}{Backspace}{Backspace}`,
      {
        initialSelectionStart: input.value.length,
        initialSelectionEnd: input.value.length
      }
    )
    expect(input.value).toBe('claude.')
    await userEvent.keyboard('code')
    expect(input.value).toBe('claude.code')
    expect([input.selectionStart, input.selectionEnd]).toEqual([11, 11])
  })

  const caret = (input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]

  it('keeps the prefix and types after it when Delete reaches it', async () => {
    const { input } = setup()
    // Delete with the caret before the dot.
    await userEvent.type(input, '{Delete}', {
      initialSelectionStart: 'claude'.length,
      initialSelectionEnd: 'claude'.length
    })
    expect(input.value).toBe('claude.code-mode')
    expect(caret(input)).toEqual([7, 7])
    await userEvent.keyboard('ab')
    expect(input.value).toBe('claude.abcode-mode')
    expect(caret(input)).toEqual([9, 9])
  })

  it('keeps the prefix when Delete reaches it on an empty suffix', async () => {
    const { input } = setup()
    await userEvent.type(input, '{Backspace}'.repeat('code-mode'.length), {
      initialSelectionStart: input.value.length,
      initialSelectionEnd: input.value.length
    })
    input.setSelectionRange('claude'.length, 'claude'.length)
    await userEvent.keyboard('{Delete}{Delete}code')
    expect(input.value).toBe('claude.code')
    expect(caret(input)).toEqual([11, 11])
  })

  it('types at the suffix start after Home', async () => {
    const { input } = setup()
    await userEvent.type(input, '{Home}ab', {
      initialSelectionStart: input.value.length,
      initialSelectionEnd: input.value.length
    })
    expect(input.value).toBe('claude.abcode-mode')
    expect(caret(input)).toEqual([9, 9])
  })

  it('keeps every typed character over a whole selection that starts like the prefix', async () => {
    const { input } = setup()
    // Ctrl+A, then a word that starts with the prefix's first letter.
    await userEvent.type(input, 'code', {
      initialSelectionStart: 0,
      initialSelectionEnd: input.value.length
    })
    expect(input.value).toBe('claude.code')
    expect(caret(input)).toEqual([11, 11])
  })

  it('replaces only the suffix part of a selection across the prefix', async () => {
    const { input } = setup()
    // `de.co` selected; the typed `d` matches the prefix letter it replaces.
    await userEvent.type(input, 'dx', {
      initialSelectionStart: 'clau'.length,
      initialSelectionEnd: 'claude.co'.length
    })
    expect(input.value).toBe('claude.dxde-mode')
    expect(caret(input)).toEqual([9, 9])
  })

  it('pastes a whole id at the suffix start when the caret is in the prefix', async () => {
    const { input } = setup()
    input.focus()
    input.setSelectionRange(3, 3)
    await userEvent.paste('claude.xyz')
    expect(input.value).toBe('claude.xyzcode-mode')
    expect(caret(input)).toEqual([10, 10])
    await userEvent.keyboard('-')
    expect(input.value).toBe('claude.xyz-code-mode')
  })

  it('pastes a whole id into an empty suffix with the caret in the prefix', async () => {
    const { input, onChangeId } = setup()
    input.focus()
    input.setSelectionRange(0, input.value.length)
    await userEvent.keyboard('{Backspace}')
    input.setSelectionRange(3, 3)
    await userEvent.paste('claude.xyz')
    expect(input.value).toBe('claude.xyz')
    expect(caret(input)).toEqual([10, 10])
    fireEvent.blur(input)
    expect(onChangeId).toHaveBeenCalledWith('claude.xyz')
  })

  it('starts an IME composition after the prefix', () => {
    const { input } = setup()
    input.focus()
    input.setSelectionRange(2, 2)
    fireEvent.compositionStart(input)
    expect(caret(input)).toEqual([7, 7])
    // A selection reaching into the suffix keeps its suffix part.
    input.setSelectionRange(2, 9)
    fireEvent.compositionStart(input)
    expect(caret(input)).toEqual([7, 9])
  })

  it('strips the prefix from a pasted whole id', async () => {
    const { input, onChangeId } = setup()
    input.focus()
    input.setSelectionRange(0, input.value.length)
    await userEvent.paste('claude.xyz')
    expect(input.value).toBe('claude.xyz')
    fireEvent.blur(input)
    expect(onChangeId).toHaveBeenCalledWith('claude.xyz')
  })

  it('checks only the suffix and does not save a bad one', async () => {
    const { input, getByText, onChangeId } = setup()
    await userEvent.type(input, '_X', {
      initialSelectionStart: input.value.length,
      initialSelectionEnd: input.value.length
    })
    expect(getByText('Use lowercase letters, digits and dashes.')).toBeTruthy()
    fireEvent.blur(input)
    expect(onChangeId).not.toHaveBeenCalled()
  })

  it("refuses another copy's id", async () => {
    const { input, getByText, onChangeId } = setup()
    input.focus()
    input.setSelectionRange(0, input.value.length)
    await userEvent.paste('taken')
    expect(getByText('Another copy has this ID.')).toBeTruthy()
    fireEvent.blur(input)
    expect(onChangeId).not.toHaveBeenCalled()
  })
})
