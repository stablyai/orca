// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

describe('model picker transcript fallback', () => {
  it('shows the pending pick instead of the historical model until the write settles', async () => {
    const snapshot: SessionOptionDescriptor[] = [
      {
        id: 'model',
        category: 'model',
        label: 'Model',
        kind: {
          type: 'select',
          choices: [
            { value: 'old-model', label: 'Previous model' },
            { value: 'new-model', label: 'Chosen model' }
          ]
        },
        valueSource: 'unknown',
        reportedModel: 'old-model',
        transport: 'catalog',
        settable: true
      }
    ]
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const surface: SessionOptionsSurface = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      setOption: async () => {
        await pending
        return { snapshot }
      },
      invokeAction: async () => ({ snapshot })
    }
    render(
      <TooltipProvider>
        <NativeChatSessionOptionPickers surface={surface} snapshot={snapshot} isWorking={false} />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /Previous model/ }))
    fireEvent.click(await screen.findByRole('option', { name: 'Chosen model' }))
    expect(screen.getByRole('button', { name: /Chosen model/ })).toBeTruthy()

    await act(async () => finish())
    expect(screen.getByRole('button', { name: /Previous model/ })).toBeTruthy()
  })
})
