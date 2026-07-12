// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { NativeChatSessionGate } from './NativeChatSessionGate'

function entry(overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>) {
  return {
    state: 'working' as const,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

function renderResolution(
  props: Omit<React.ComponentProps<typeof NativeChatSessionGate>, 'children'>
): void {
  render(
    <NativeChatSessionGate {...props}>
      {(resolution) => (
        <div data-testid="native-chat-resolution">
          {resolution.agent}:{resolution.sessionId ?? 'no-session'}:{resolution.paneKey}
        </div>
      )}
    </NativeChatSessionGate>
  )
}

describe('NativeChatSessionGate', () => {
  afterEach(() => {
    cleanup()
  })

  it.each(['codex', 'claude'] as const)(
    'opens the resolved native chat session from a %s title fallback',
    (resolvedAgent) => {
      renderResolution({
        paneKey: 'tab-1:leaf-1',
        launchAgent: null,
        resolvedAgent,
        ptyId: 'pty-1'
      })

      expect(screen.getByTestId('native-chat-resolution')).toHaveTextContent(
        `${resolvedAgent}:no-session:tab-1:leaf-1`
      )
    }
  )

  it('keeps live hook identity ahead of a stale title fallback', () => {
    renderResolution({
      paneKey: 'tab-1:leaf-1',
      launchAgent: null,
      agentStatusEntry: entry({
        paneKey: 'tab-1:leaf-1',
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session' }
      }),
      resolvedAgent: 'codex',
      ptyId: 'pty-1'
    })

    expect(screen.getByTestId('native-chat-resolution')).toHaveTextContent(
      'claude:claude-session:tab-1:leaf-1'
    )
  })

  it('does not open native chat from an unsupported title fallback', () => {
    renderResolution({
      paneKey: 'tab-1:leaf-1',
      launchAgent: null,
      resolvedAgent: 'gemini',
      ptyId: 'pty-1'
    })

    expect(screen.getByText('No conversation here')).toBeInTheDocument()
    expect(screen.queryByTestId('native-chat-resolution')).not.toBeInTheDocument()
  })
})
