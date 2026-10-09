// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as I18nModule from '@/i18n/i18n'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => values?.[name] ?? placeholder)
}))
afterEach(cleanup)

describe('the known chat agent on returned cards', () => {
  it.each(['Codex', 'Claude'])('names %s when the card has its own Send control', (agentName) => {
    render(
      <TooltipProvider>
        <NativeChatQueuedMessageCard
          agentName={agentName}
          chatWorktreeId={null}
          card={{
            messageId: 'returned',
            position: 1,
            text: 'My retained message',
            state: 'returned',
            hold: 'returned',
            returnedRejection: { kind: 'writeFailed' }
          }}
          showsSteerShortcut={false}
          onSteer={() => undefined}
          onDelete={() => undefined}
          onEdit={() => undefined}
        />
      </TooltipProvider>
    )
    expect(screen.getByText(`${agentName} couldn't receive this message.`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.queryByText('Send it again.')).toBeNull()
  })
})
