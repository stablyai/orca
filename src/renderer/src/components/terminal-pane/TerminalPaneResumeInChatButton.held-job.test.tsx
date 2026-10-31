// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import {
  TEST_REPO,
  makeWorktree,
  makeTerminalTab
} from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  readLocalRuntimeCapabilitiesOrUnknown: () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  subscribeLocalRuntimeCapabilityObservation: () => () => {}
}))
afterEach(cleanup)
it.each(['suspended'] as const)(
  'keeps the real Claude header/menu switchable during held %s work and after exit',
  () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    const paneKey = 'shell:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    useAppStore.setState({
      settings: createGlobalSettingsFixture(),
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1' })] },
      tabsByWorktree: { 'wt-1': [makeTerminalTab({ id: 'shell', worktreeId: 'wt-1' })] },
      terminalLayoutsByTabId: {
        shell: {
          root: { type: 'leaf', leafId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
          activeLeafId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          expandedLeafId: null,
          ptyIdsByLeafId: { '3f2504e0-4f89-41d3-9a0c-0305e82c3301': 'pty-1' }
        }
      }
    })
    useAppStore
      .getState()
      .recordAgentProviderSession(
        paneKey,
        'claude',
        { key: 'session_id', id: 'real-claude' },
        undefined,
        { worktreeId: 'wt-1', tabId: 'shell' }
      )
    useAppStore.getState().setPaneForegroundAgent(paneKey, {
      agent: 'claude',
      shellForeground: true,
      suspendedAgent: 'claude'
    })
    render(
      <TooltipProvider>
        <TerminalPaneResumeInChatButton tabId="shell" worktreeId="wt-1" paneKey={paneKey} />
      </TooltipProvider>
    )
    const header = screen.getByRole('button', { name: 'Switch to native chat', hidden: true })
    expect(header.hasAttribute('disabled')).toBe(false)
    act(() =>
      useAppStore.getState().setPaneForegroundAgent(paneKey, { agent: null, shellForeground: true })
    )
    expect(header.hasAttribute('disabled')).toBe(false)
  }
)

vi.mock('@/components/confirmation-dialog-context', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirmationDialog: () => vi.fn(async () => false)
}))
