// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerPlanChip, useNativeChatPlanMode } from './NativeChatComposerPlanChip'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import { structuredAgentSessionInteractionDescriptor } from '../../../../shared/agent-session/options/agent-session-interaction-mode'
import { createStructuredAgentSessionOptionState } from '../../../../shared/agent-session/options/structured-agent-session-options'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => 0 }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(cleanup)

function PlanChip(props: Parameters<typeof useNativeChatPlanMode>[0]) {
  return <NativeChatComposerPlanChip control={useNativeChatPlanMode(props)} />
}

it('shows only active Plan, exits with an absolute Build choice, and retains Plan after a failed exit', async () => {
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
  const renderChip = (snapshot: (typeof descriptor)[]) => (
    <TooltipProvider>
      <PlanChip surface={surface} snapshot={snapshot} focusComposer={focus} />
    </TooltipProvider>
  )
  const view = render(renderChip([descriptor]))
  expect(screen.queryByRole('button')).toBeNull()
  const plan = {
    ...descriptor,
    kind: { type: 'select' as const, currentValue: 'plan', choices: [] }
  }
  view.rerender(renderChip([plan]))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit plan mode' })))
  expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'default')
  expect(screen.getByRole('button', { name: 'Exit plan mode' })).toHaveProperty('disabled', false)
  expect(focus).toHaveBeenCalledOnce()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Exit plan mode' })))
  expect(setOption).toHaveBeenLastCalledWith('interactionMode', 'default')
  view.rerender(renderChip([descriptor]))
  expect(screen.queryByRole('button')).toBeNull()
  view.rerender(renderChip([]))
  expect(screen.queryByRole('button')).toBeNull()
})
