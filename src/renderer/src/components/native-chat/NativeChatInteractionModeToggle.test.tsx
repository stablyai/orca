// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatInteractionModeToggle } from './NativeChatInteractionModeToggle'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import { structuredAgentSessionInteractionDescriptor } from '../../../../shared/agent-session/options/agent-session-interaction-mode'
import { createStructuredAgentSessionOptionState } from '../../../../shared/agent-session/options/structured-agent-session-options'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => 0 }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(cleanup)

it('writes an absolute Plan or Build choice, keeps a failed choice unchanged, and returns composer focus', async () => {
  const descriptor = structuredAgentSessionInteractionDescriptor({
    ...createStructuredAgentSessionOptionState('codex', null),
    interactionModeSupported: true
  })!
  const setOption = vi
    .fn<SessionOptionsSurface['setOption']>()
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockResolvedValue({ snapshot: [] })
  const surface: SessionOptionsSurface = {
    getSnapshot: () => [descriptor],
    setOption,
    invokeAction: async () => ({ snapshot: [] }),
    subscribe: () => () => {}
  }
  const focus = vi.fn()
  const view = render(
    <TooltipProvider>
      <NativeChatInteractionModeToggle
        surface={surface}
        snapshot={[descriptor]}
        focusComposer={focus}
      />
    </TooltipProvider>
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { pressed: false })))
  expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'plan')
  expect(screen.getByRole('button', { pressed: false })).toHaveProperty('disabled', false)
  expect(focus).toHaveBeenCalledOnce()
  view.rerender(
    <TooltipProvider>
      <NativeChatInteractionModeToggle
        surface={surface}
        snapshot={[{ ...descriptor, kind: { type: 'select', currentValue: 'plan', choices: [] } }]}
      />
    </TooltipProvider>
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { pressed: true })))
  expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'default')
  view.rerender(
    <TooltipProvider>
      <NativeChatInteractionModeToggle surface={surface} snapshot={[]} />
    </TooltipProvider>
  )
  expect(screen.queryByRole('button')).toBeNull()
})
