// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatCodeBlock, NativeChatPlainCodeBlock } from './NativeChatCodeBlock'
import { NativeChatComposerInsertHost } from './native-chat-composer-insert-context'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const INSERT = { name: 'Insert into prompt' }

function composerHandle(insertTypedText: NativeChatComposerHandle['insertTypedText']): {
  current: NativeChatComposerHandle
} {
  return {
    current: {
      focus: () => true,
      insertTypedText,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => false
    }
  }
}

describe('NativeChatCodeBlock insert-into-prompt action', () => {
  it('drops the block verbatim at the composer caret when clicked', () => {
    const insertTypedText = vi.fn(() => true)
    const code = '! ls -la\n'
    render(
      <NativeChatComposerInsertHost composerRef={composerHandle(insertTypedText)}>
        <NativeChatCodeBlock language="bash">
          <code>{code}</code>
        </NativeChatCodeBlock>
      </NativeChatComposerInsertHost>
    )

    fireEvent.click(screen.getByRole('button', INSERT))

    expect(insertTypedText).toHaveBeenCalledWith(code)
  })

  it('shows no insert action without a composer host', () => {
    render(
      <NativeChatCodeBlock language="bash">
        <code>{'! ls\n'}</code>
      </NativeChatCodeBlock>
    )

    expect(screen.queryByRole('button', INSERT)).toBeNull()
  })

  it('shows no insert action on a dimmed plain block', () => {
    render(
      <NativeChatComposerInsertHost composerRef={composerHandle(vi.fn(() => true))}>
        <NativeChatPlainCodeBlock language="bash">
          <code>{'! ls\n'}</code>
        </NativeChatPlainCodeBlock>
      </NativeChatComposerInsertHost>
    )

    expect(screen.queryByRole('button', INSERT)).toBeNull()
  })

  it('shows no insert action for an empty block', () => {
    render(
      <NativeChatComposerInsertHost composerRef={composerHandle(vi.fn(() => true))}>
        <NativeChatCodeBlock language="bash" />
      </NativeChatComposerInsertHost>
    )

    expect(screen.queryByRole('button', INSERT)).toBeNull()
  })
})
