// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  TerminalRichInputFileMention,
  TerminalRichInputFileMentionChip
} from './TerminalRichInputFileMention'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { value0?: string }) =>
    fallback.replace('{{value0}}', options?.value0 ?? '')
}))

afterEach(cleanup)

describe('TerminalRichInputFileMentionChip', () => {
  it('opens files and exposes removal only on hover or focus', async () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(
      <TerminalRichInputFileMentionChip
        path="README.md"
        isDirectory={false}
        onOpen={onOpen}
        onRemove={onRemove}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open README.md in Orca' }))
    expect(onOpen).toHaveBeenCalledOnce()

    const remove = screen.getByRole('button', { name: 'Remove README.md' })
    expect(remove.classList.contains('can-hover:opacity-0')).toBe(true)
    expect(remove.className).toContain('group-hover:opacity-100')
    await userEvent.click(remove)
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('allows chip labels to participate in native text selection', () => {
    const { container } = render(
      <TerminalRichInputFileMentionChip
        path="README.md"
        isDirectory={false}
        selected
        onOpen={() => {}}
        onRemove={() => {}}
      />
    )

    expect(container.firstElementChild?.classList.contains('select-none')).toBe(false)
    expect(container.firstElementChild?.classList.contains('ring-1')).toBe(true)
  })

  it('copies the chip as a portable file reference', () => {
    expect(
      TerminalRichInputFileMention.config.renderText?.call(
        {} as never,
        {
          node: { attrs: { path: '/repo/README.md' } }
        } as never
      )
    ).toBe('@/repo/README.md')
  })

  it('uses Orca folder chrome for directory mentions', () => {
    const { container } = render(
      <TerminalRichInputFileMentionChip
        path="src"
        isDirectory
        onOpen={() => {}}
        onRemove={() => {}}
      />
    )

    expect(container.querySelector('.lucide-folder')).not.toBeNull()
  })

  it('shows rich content supplied for image hover previews', async () => {
    render(
      <TerminalRichInputFileMentionChip
        path="design.png"
        isDirectory={false}
        onOpen={() => {}}
        onRemove={() => {}}
        preview={<div>image/png preview</div>}
      />
    )

    await userEvent.hover(screen.getByRole('button', { name: 'Open design.png in Orca' }))
    expect(await screen.findByText('image/png preview')).toBeTruthy()
  })
})
