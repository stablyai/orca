// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

// Open in place, so the rows render without driving Radix focus and portals.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

afterEach(cleanup)

const model: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  transport: 'agent-session',
  settable: true,
  valueSource: 'applied',
  kind: {
    type: 'select',
    currentValue: 'sonnet',
    choices: [
      { value: 'opus', label: 'Opus 5.5' },
      { value: 'sonnet', label: 'Sonnet 5' }
    ]
  },
  defaultChoice: {
    selected: false,
    model: { value: 'opus', label: 'Opus 5.5', description: 'Set in this workspace' }
  }
}

it("keeps the reported default model's description on the Default row", () => {
  const snapshot = [model]
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={{
          getSnapshot: () => snapshot,
          subscribe: () => () => {},
          setOption: async () => ({ snapshot }),
          invokeAction: async () => ({ snapshot }),
          resetOption: async () => ({ snapshot })
        }}
        isWorking={false}
        snapshot={snapshot}
      />
    </TooltipProvider>
  )
  const row = screen.getByText('Default').closest('[cmdk-item]')
  expect(row?.textContent).toContain('Opus 5.5')
  expect(row?.textContent).toContain('Set in this workspace')
})
