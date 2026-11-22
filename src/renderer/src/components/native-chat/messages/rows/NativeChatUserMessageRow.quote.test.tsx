// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import { MessageRow } from './NativeChatMessageRow'

afterEach(cleanup)

it('shows the quote in a sent user message as a quote chip', () => {
  render(
    <TooltipProvider>
      <MessageRow
        message={{
          id: 'sent',
          role: 'user',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text: '> q\n\nreply' }]
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    </TooltipProvider>,
    { wrapper: TranslationScopeProvider }
  )
  expect(document.querySelector('[data-native-chat-sent-quote]')).toHaveTextContent('Quote: q')
  expect(screen.getByText('reply')).toBeInTheDocument()
})
