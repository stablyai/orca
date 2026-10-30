// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
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
vi.mock('./use-orchestration-crew', () => ({
  useOrchestrationCrew: () => ({
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
  })
}))
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const first = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
const second = testOrcaSessionId('22222222-2222-4222-8222-222222222222')
beforeEach(() => {
  resetStructuredSessionMocks()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
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
