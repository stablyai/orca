// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { getAutomationRunViewState } from './automation-run-view-state'
import type { AutomationRunViewState } from './automation-run-view-state'

// These fixtures exercise markdown without rendering diagrams.
const boundaryMocks = vi.hoisted(() => ({
  mermaid: vi.fn(() => {
    throw new Error('These fixtures must not render Mermaid diagrams')
  })
}))

vi.mock('@/components/sidebar/CommentMermaidBlock', () => ({ default: boundaryMocks.mermaid }))

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Run 1',
  scheduledFor: 1,
  status: 'skipped_precheck',
  trigger: 'scheduled',
  workspaceId: 'wt-1',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: 'Precheck exited with code 1.',
  startedAt: 1,
  dispatchedAt: null,
  createdAt: 1
}

function renderPage(viewState: AutomationRunViewState): void {
  render(
    <AutomationRunDetailsPage
      automation={null}
      run={run}
      relativeNow={1}
      workspaceDisplay={null}
      viewState={viewState}
      canRerun={false}
      isRerunPending={false}
      onRerun={() => {}}
      onOpenWorkspace={() => {}}
      onBack={() => {}}
    />
  )
}

describe('AutomationRunDetailsPage', () => {
  afterEach(() => {
    cleanup()
    try {
      expect(boundaryMocks.mermaid).not.toHaveBeenCalled()
    } finally {
      boundaryMocks.mermaid.mockClear()
    }
  })

  it('enables the open action when the supplied view state allows it', () => {
    renderPage({
      availability: 'terminal',
      actionLabel: 'View run',
      statusLabel: 'Run is open',
      canOpen: true
    })
    expect(screen.getByRole('button', { name: 'View run' })).toBeEnabled()
  })

  it('renders the real Chat action from normally loaded Spanish resources', async () => {
    const previous = i18n.language
    const hadSpanish = i18n.hasResourceBundle('es', 'translation')
    try {
      await loadRendererUiLanguage('es')
      await i18n.changeLanguage('es')
      const chat = { ...run, sessionKind: 'chat' as const, chatSessionId: 'pi_saved_chat' }
      const viewState = getAutomationRunViewState({
        run: chat,
        workspaceExists: true,
        terminalTargetExists: false
      })
      expect(viewState).toEqual({
        availability: 'chat',
        actionLabel: 'Ver ejecución',
        statusLabel: 'La ejecución está abierta',
        canOpen: true
      })
      const open = vi.fn()
      render(
        <AutomationRunDetailsPage
          automation={null}
          run={chat}
          relativeNow={1}
          workspaceDisplay={null}
          viewState={viewState}
          canRerun={false}
          isRerunPending={false}
          onRerun={() => {}}
          onOpenWorkspace={open}
          onBack={() => {}}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Ver ejecución' }))
      expect(open).toHaveBeenCalledOnce()
      expect(chat.chatSessionId).toBe('pi_saved_chat')
    } finally {
      await i18n.changeLanguage(previous)
      if (!hadSpanish) {
        i18n.removeResourceBundle('es', 'translation')
      }
    }
  })

  it('hides the open action when the supplied view state disallows it', () => {
    renderPage({
      availability: 'metadata',
      actionLabel: 'View run',
      statusLabel: 'Workspace no longer available',
      canOpen: false
    })
    expect(screen.queryByRole('button', { name: 'View run' })).not.toBeInTheDocument()
    expect(screen.getByText('Precheck exited with code 1.')).toBeInTheDocument()
  })
})
