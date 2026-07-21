// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Why: crash 34c478b4 (React 19 "#185 / Maximum update depth exceeded") looped
// through Radix `setRef` because PickerTrigger nested `TooltipTrigger asChild`
// and `DropdownMenuTrigger asChild` onto the SAME Button — the exact anti-pattern
// fixed in #7096. This guards the wrapper element that keeps the two triggers
// from composing refs onto one node, so the composition can never regress.

const modelDescriptor: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: {
    type: 'select',
    currentValue: 'sonnet',
    choices: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' }
    ]
  },
  valueSource: 'applied',
  settable: true
}

const optionDescriptor: SessionOptionDescriptor = {
  id: 'mode',
  label: 'Mode',
  category: 'mode',
  kind: {
    type: 'select',
    currentValue: 'auto',
    choices: [
      { value: 'auto', label: 'Auto' },
      { value: 'plan', label: 'Plan' }
    ]
  },
  valueSource: 'applied',
  settable: true
}

function makeSurface(snapshot: SessionOptionDescriptor[]): SessionOptionsSurface {
  return {
    getSnapshot: () => snapshot,
    setOption: vi.fn(async () => ({ snapshot })),
    invokeAction: vi.fn(async () => ({ snapshot })),
    subscribe: () => () => {}
  }
}

function Harness(): ReactElement {
  const snapshot = [modelDescriptor, optionDescriptor]
  return (
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={makeSurface(snapshot)}
        snapshot={snapshot}
        isWorking={false}
      />
    </TooltipProvider>
  )
}

describe('NativeChatSessionOptionPickers ref loop guard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('renders each picker trigger without composing Tooltip + Dropdown refs onto one button', async () => {
    // If the nested-asChild composition regressed, mounting would loop through
    // Radix setRef and act() would throw "Maximum update depth exceeded".
    await act(async () => {
      root.render(<Harness />)
    })

    const triggers = container.querySelectorAll<HTMLButtonElement>('button[aria-label]')
    // Both the options picker and the model picker render a trigger.
    expect(triggers.length).toBe(2)
    for (const trigger of triggers) {
      // The wrapper <span> sits between TooltipTrigger and DropdownMenuTrigger,
      // so the button's parent must be that SPAN, never a second Radix trigger.
      expect(trigger.parentElement?.tagName).toBe('SPAN')
    }
  })

  it('renders a picker menu with its choices when opened', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const modelTrigger = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].at(
      -1
    )
    expect(modelTrigger).toBeDefined()

    await act(async () => {
      modelTrigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Opus')
  })
})
