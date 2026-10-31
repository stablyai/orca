// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { getAutomationRunContent } from '../../../../shared/automation-run-content'
import { getAutomationRunContent as getDesktopRunContent } from './automation-run-content'
import { automationRunFailure } from '../../../../shared/automation-run-failure-copy'
import es from '@/i18n/locales/es.json'
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

function renderPage(viewState: AutomationRunViewState, selectedRun: AutomationRun = run): void {
  render(
    <AutomationRunDetailsPage
      automation={null}
      run={selectedRun}
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

  it('localizes coded failures without replacing saved output or legacy error text', async () => {
    const originalLanguage = i18n.language
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    try {
      const codedRun: AutomationRun = { ...run, ...automationRunFailure('targetMissing') }
      expect(getDesktopRunContent(codedRun)).toBe(es.automations.runFailures.targetMissing)
      expect(getDesktopRunContent({ ...codedRun, errorCode: 'futureCode' })).toBe(codedRun.error)
      expect(
        getDesktopRunContent({
          ...codedRun,
          outputSnapshot: {
            format: 'plain_text',
            content: ' saved output ',
            capturedAt: 1,
            truncated: false
          }
        })
      ).toBe(' saved output ')
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
  })

  it('localizes empty desktop output while the shared mobile default remains available', async () => {
    const emptyRun: AutomationRun = { ...run, error: null }
    expect(getAutomationRunContent(emptyRun)).toBe('No output content available.')
    const originalLanguage = i18n.language
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    try {
      renderPage(
        {
          availability: 'metadata',
          actionLabel: 'View run',
          statusLabel: 'Run is complete',
          canOpen: false
        },
        emptyRun
      )
      expect(
        screen.getByText(es.auto.components.automations.runContent.noOutput)
      ).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
  })
})
