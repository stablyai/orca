// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { holdPhysicalCloseTasks } from '../orchestration-crew/crew-menu.test-fixture'
import type { OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
const crew = vi.hoisted(() => {
  const snapshot: OrchestrationCrewSnapshot = {
    status: 'ok',
    sections: {
      managedBy: [],
      talkingWith: [],
      managing: [
        {
          partyKey: 'worker',
          role: 'worker',
          label: 'Worker',
          agentKind: 'codex',
          status: 'working',
          sendAddress: 'dispatch:d1',
          task: { title: 'Check the result', state: 'active' }
        }
      ]
    }
  }
  const release = vi.fn()
  const subscribe = vi.fn((_listener: () => void) => release)
  return { snapshot, release, subscribe }
})
vi.mock('../orchestration-crew/orchestration-crew-follow', () => ({
  observeCrew: () => ({ subscribe: crew.subscribe, read: () => crew.snapshot })
}))
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const first = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
const second = testOrcaSessionId('22222222-2222-4222-8222-222222222222')
beforeEach(() => {
  resetStructuredSessionMocks()
  crew.subscribe.mockClear()
  crew.release.mockClear()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

it('handles sibling-composer Escape at the actual native pane boundary and keeps other panes and nested menus independent', async () => {
  const user = userEvent.setup()
  const view = render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="crew-first"
        sessionId={first}
        target={{ kind: 'local' }}
        agent="codex"
      />
      <NativeChatStructuredSession
        isVisible={true}
        isFocusedGroup={false}
        tabId="crew-second"
        sessionId={second}
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
  const roots = view.container.querySelectorAll('[data-native-chat-root]')
  expect(roots).toHaveLength(2)
  const [firstRoot, secondRoot] = roots
  if (!(firstRoot instanceof HTMLElement) || !(secondRoot instanceof HTMLElement)) {
    throw new Error('Expected two native chat pane elements')
  }
  const pane = within(firstRoot),
    other = within(secondRoot)
  await user.click(pane.getByRole('button', { name: 'Show crew: 1 workers' }))
  await user.click(other.getByRole('button', { name: 'Show crew: 1 workers' }))
  const composer = pane.getByRole('textbox', { name: 'Message' })
  const otherComposer = other.getByRole('textbox', { name: 'Message' })
  await user.type(composer, 'Keep this draft')
  fireEvent.keyDown(composer, { key: 'Escape', isComposing: true })
  expect(pane.getByRole('complementary', { name: 'Agent crew' })).toBeInTheDocument()
  const ownsEscape = (event: KeyboardEvent) => event.preventDefault()
  document.addEventListener('keydown', ownsEscape, { capture: true })
  fireEvent.keyDown(composer, { key: 'Escape' })
  document.removeEventListener('keydown', ownsEscape, { capture: true })
  expect(pane.getByRole('complementary', { name: 'Agent crew' })).toBeInTheDocument()
  await user.click(pane.getByRole('button', { name: 'More for Worker' }))
  expect(screen.getByRole('menu')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(pane.getByRole('complementary', { name: 'Agent crew' })).toBeInTheDocument()
  await waitFor(() => expect(pane.getByRole('button', { name: 'More for Worker' })).toHaveFocus())
  await user.keyboard('{Escape}')
  expect(pane.queryByRole('complementary', { name: 'Agent crew' })).not.toBeInTheDocument()
  expect(pane.getByRole('button', { name: 'Show crew: 1 workers' })).toHaveFocus()
  await user.click(pane.getByRole('button', { name: 'Show crew: 1 workers' }))
  composer.focus()
  await user.keyboard('{Escape}')
  expect(pane.queryByRole('complementary')).not.toBeInTheDocument()
  expect(composer).toHaveValue('Keep this draft')
  expect(other.getByRole('complementary', { name: 'Agent crew' })).toBeInTheDocument()
  otherComposer.focus()
  await user.keyboard('{Escape}')
  expect(other.queryByRole('complementary', { name: 'Agent crew' })).not.toBeInTheDocument()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.stop).not.toHaveBeenCalled()
})

it('ends only the native menu lifetime on hide, retaining disclosure and the subscribed Crew owner', async () => {
  const tasks = holdPhysicalCloseTasks()
  const user = userEvent.setup()
  const content = (isVisible: boolean) => (
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible={isVisible}
        isFocusedGroup={false}
        tabId="crew-first"
        sessionId={first}
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
  const view = render(content(true))
  await user.click(screen.getByRole('button', { name: 'Show crew: 1 workers' }))
  const panel = screen.getByRole('complementary', { name: 'Agent crew' })
  const disclosure = screen.getByRole('button', { name: /Worker Check the result/ })
  await user.click(disclosure)
  const composer = screen.getByRole('textbox', { name: 'Message' })
  await user.type(composer, 'Keep this draft')
  const oldMore = screen.getByRole('button', { name: 'More for Worker' })
  await user.click(oldMore)
  const firstPopup = screen.getByRole('menu')
  const oldFocus = vi.spyOn(oldMore, 'focus')

  view.rerender(content(false))
  expect(firstPopup.isConnected).toBe(false)
  expect(oldMore.isConnected).toBe(false)
  expect(tasks).toHaveLength(1)
  expect(screen.getByRole('complementary', { name: 'Agent crew' })).toBe(panel)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(crew.subscribe).toHaveBeenCalledOnce()
  expect(crew.release).not.toHaveBeenCalled()

  view.rerender(content(true))
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  const more = screen.getByRole('button', { name: 'More for Worker' })
  expect(more).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(composer)
  expect(composer).toHaveValue('Keep this draft')
  await user.click(more)
  const secondPopup = screen.getByRole('menu')
  expect(secondPopup).not.toBe(firstPopup)
  const focus = vi.spyOn(more, 'focus')
  act(tasks[0])
  expect(oldFocus).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  expect(screen.getByRole('menu')).toBe(secondPopup)
  expect(more).toHaveAttribute('aria-expanded', 'true')
  await user.keyboard('{Escape}')
  expect(secondPopup.isConnected).toBe(false)
  expect(tasks).toHaveLength(2)
  act(tasks[1])
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  expect(more).toHaveFocus()
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(crew.subscribe).toHaveBeenCalledOnce()
  expect(crew.release).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.stop).not.toHaveBeenCalled()
  view.unmount()
  expect(crew.release).toHaveBeenCalledOnce()
})
