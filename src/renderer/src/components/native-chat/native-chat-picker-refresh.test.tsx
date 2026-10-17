// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

it('refreshes the model catalog when the real model dropdown opens', async () => {
  const refresh = vi.fn()
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={{
          refresh,
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        }}
        snapshot={[
          {
            id: 'model',
            label: 'Model',
            category: 'model',
            kind: {
              type: 'select',
              currentValue: 'flash',
              choices: [{ value: 'flash', label: 'Flash' }]
            },
            valueSource: 'reported',
            transport: 'catalog',
            settable: true
          }
        ]}
        isWorking={false}
      />
    </TooltipProvider>
  )
  expect(refresh).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' })
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(await screen.findByRole('option', { name: /Flash/ })).not.toBeNull()
})
