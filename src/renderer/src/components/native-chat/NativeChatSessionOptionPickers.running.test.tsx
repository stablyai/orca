// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../../shared/structured-agent-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))

afterEach(cleanup)

it('allows a running Codex chat to pick its next model and effort through the real popover', async () => {
  const user = userEvent.setup()
  const snapshot = structuredAgentSessionOptionSnapshot(
    applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: ['gpt-current', 'gpt-next'].map((id) => ({
          id,
          label: id,
          isDefault: id === 'gpt-current',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        })),
        current: { model: 'gpt-current', effort: 'high', confirmed: ['model', 'effort'] }
      }
    )
  )
  const setOption = vi.fn(async () => ({ snapshot }))
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={{
          getSnapshot: () => snapshot,
          setOption,
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        }}
        snapshot={snapshot}
        isWorking
      />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: /Model gpt-current/ })
  expect(trigger).toHaveProperty('disabled', false)
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name: 'gpt-next' }))
  await waitFor(() => expect(setOption).toHaveBeenCalledWith('model', 'gpt-next'))
  await user.click(screen.getByRole('radio', { name: 'Med' }))
  await waitFor(() => expect(setOption).toHaveBeenCalledWith('effort', 'medium'))
  expect(setOption).toHaveBeenCalledTimes(2)
})
