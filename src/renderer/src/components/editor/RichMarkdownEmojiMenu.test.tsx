// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichMarkdownEmojiMenu } from './RichMarkdownEmojiMenu'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('emoji-picker-react', () => ({
  default: () => <div data-testid="emoji-picker" />,
  EmojiStyle: { NATIVE: 'native' },
  Theme: { AUTO: 'auto' }
}))

afterEach(cleanup)

describe('RichMarkdownEmojiMenu', () => {
  it('announces the popup as a named dialog', () => {
    render(<RichMarkdownEmojiMenu editor={null} left={0} top={0} onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeTruthy()
  })
})
