// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

afterEach(() => {
  cleanup()
})

it('omits CLI-update rows when the CLI already lists a context-window or dated variant', () => {
  const noop = () => {}
  render(
    <TooltipProvider>
      <NativeChatModelCombobox
        choices={[
          { value: 'claude-fable-5-2[1m]', label: 'Claude Fable 5.2 (1M context)' },
          { value: 'claude-haiku-5-5-20260901', label: 'Claude Haiku 5.5' }
        ]}
        currentValue="claude-fable-5-2[1m]"
        readOnly={false}
        readOnlyReason={null}
        busy={false}
        onSelect={noop}
        cliUpdate={{
          agent: 'claude',
          models: [
            { id: 'claude-fable-5-2', name: 'Fable 5.2', minVersion: '2.1.321' },
            { id: 'claude-haiku-5-5', name: 'Haiku 5.5', minVersion: '2.1.293' },
            { id: 'claude-opus-5-5', name: 'Opus 5.5', minVersion: '2.1.280' }
          ],
          runnable: true,
          phase: 'idle',
          start: noop,
          openFailure: noop
        }}
      />
    </TooltipProvider>
  )

  expect(screen.queryByText('Fable 5.2')).toBeNull()
  expect(screen.queryByText('Haiku 5.5')).toBeNull()
  expect(screen.getByText('Opus 5.5')).toBeTruthy()
})
