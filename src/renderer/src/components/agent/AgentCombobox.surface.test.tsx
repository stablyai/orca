// @vitest-environment happy-dom

import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { buildNewTabAgentMenuRows, type NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'
import type { NewTabAgentMenuModel } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'
import AgentCombobox from './AgentCombobox'
import { resolveAgentMenuSelection } from '@/lib/agent-menu-selection'

afterEach(cleanup)

const detection: UseDetectedAgentsResult = {
  detectedIds: ['claude', 'codex', 'gemini', 'grok'],
  isLoading: false,
  detectionFailed: false,
  isRefreshing: false,
  needsServerUpdate: false,
  refresh: async () => []
}

function settled(rows: NewTabAgentMenuRow[]): NewTabAgentMenuModel {
  return { state: 'settled', rows, detection }
}

const CHAT_ROWS: NewTabAgentMenuRow[] = [
  { kind: 'chat', agent: 'claude' },
  { kind: 'chat', agent: 'codex' },
  { kind: 'chat-unavailable', agent: 'grok', reason: 'subfolder' },
  { kind: 'cli', agent: 'gemini', chat: true },
  { kind: 'cli', agent: 'grok' }
]

function renderPicker(
  model: NewTabAgentMenuModel,
  value: TuiAgent | null,
  surface?: AgentLaunchSurface
): { onPick: ReturnType<typeof vi.fn> } {
  const onPick = vi.fn()
  const element: ReactElement = (
    <AgentCombobox
      agents={AGENT_CATALOG.filter((agent) => agent.id !== 'grok')}
      value={value}
      onValueChange={vi.fn()}
      allowBlankTerminal
      surfaceRows={{
        model,
        surface,
        onPick,
        selection: resolveAgentMenuSelection({
          agent: value,
          surface,
          settings: { nativeChatProviders: EVERY_AGENT_CHAT },
          inventoryReady: model.state === 'settled',
          answer:
            model.state === 'settled' &&
            model.rows.some((row) => row.agent === value && row.kind === 'chat')
              ? 'yes'
              : 'no-chats',
          chatPending: model.state === 'loading',
          plain: model.state === 'settled' && model.rows.every((row) => row.kind === 'terminal')
        })
      }}
    />
  )
  render(element, { wrapper: TooltipProvider })
  return { onPick }
}

function option(text: string): HTMLElement {
  const match = screen
    .getAllByRole('option')
    .find((candidate) => candidate.textContent?.startsWith(text))
  if (!match) {
    throw new Error(`no option ${text}`)
  }
  return match
}

describe('AgentCombobox surface rows', () => {
  it('picks a chat from the row and the CLI from its terminal button or the keyboard', () => {
    const { onPick } = renderPicker(settled(CHAT_ROWS), 'claude')
    expect(screen.getByRole('combobox').textContent).toBe('Claude')

    fireEvent.click(screen.getByRole('combobox'))
    expect(option('Gemini').textContent).toBe('Gemini (CLI)')
    expect(within(option('Gemini')).queryByRole('button')).toBeNull()
    expect(option('Grok').getAttribute('aria-disabled')).toBe('true')
    expect(option('Grok').textContent).toContain('No chat in a subfolder')
    fireEvent.click(option('Codex'))
    expect(onPick).toHaveBeenLastCalledWith('codex', 'chat')

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex in a terminal' }))
    expect(onPick).toHaveBeenLastCalledWith('codex', 'terminal')

    fireEvent.click(screen.getByRole('combobox'))
    const search = screen.getByPlaceholderText('Search agents...')
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith('claude', 'terminal')
    expect(onPick).toHaveBeenCalledTimes(3)

    // A mouse commit and a dismissed interaction both cancel a transient terminal arm.
    for (const dismiss of [false, true]) {
      fireEvent.click(screen.getByRole('combobox'))
      const input = screen.getByPlaceholderText('Search agents...')
      fireEvent.keyDown(input, { key: 'ArrowRight' })
      if (dismiss) {
        fireEvent.keyDown(input, { key: 'Escape' })
      } else {
        fireEvent.click(option('Claude'))
      }
      fireEvent.click(screen.getByRole('combobox'))
      fireEvent.keyDown(screen.getByPlaceholderText('Search agents...'), { key: 'Enter' })
      expect(onPick).toHaveBeenLastCalledWith('claude', 'chat')
    }
    fireEvent.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText('Search agents...')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    fireEvent.pointerMove(option('Codex'))
    fireEvent.pointerMove(option('Claude'))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith('claude', 'chat')

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(option('Gemini'))
    expect(onPick).toHaveBeenLastCalledWith('gemini', 'terminal')
  })

  it('shows a terminal pick as the CLI and keeps its button lit on reopen', () => {
    renderPicker(settled(CHAT_ROWS), 'claude', 'terminal')
    expect(screen.getByRole('combobox').textContent).toBe('Claude (CLI)')
    fireEvent.click(screen.getByRole('combobox'))
    expect(
      screen
        .getByRole('button', { name: 'Start Claude in a terminal' })
        .getAttribute('aria-pressed')
    ).toBe('true')
  })

  it('keeps the plain list when chats are off, and waits for the host before labelling', () => {
    renderPicker(
      settled([
        { kind: 'terminal', agent: 'claude' },
        { kind: 'terminal', agent: 'codex' }
      ]),
      'claude',
      'terminal'
    )
    expect(screen.getByRole('combobox').textContent).toBe('Claude')
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('button', { name: /in a terminal/ })).toBeNull()
    cleanup()

    renderPicker({ state: 'loading', placeholderCount: 2 }, 'claude')
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  })
})

it('keeps exact-agent search ahead of the default agent', () => {
  const { onPick } = renderPicker(
    settled([
      { kind: 'terminal', agent: 'openclaude' },
      { kind: 'terminal', agent: 'claude' }
    ]),
    'openclaude'
  )
  fireEvent.click(screen.getByRole('combobox'))
  const input = screen.getByPlaceholderText('Search agents...')
  fireEvent.change(input, { target: { value: 'claude' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onPick).toHaveBeenCalledExactlyOnceWith('claude', 'terminal')
})

it('keeps a recorded host chat without its CLI on CHAT after ArrowRight and Enter', () => {
  // QA controls/phase-matrix/probe.json: external.raw.inventory + streams.health[0].result.
  const detectedOnHost: TuiAgent[] = ['codex', 'opencode', 'pi', 'omp']
  const rows = buildNewTabAgentMenuRows({
    settings: { nativeChatProviders: EVERY_AGENT_CHAT, defaultTuiAgent: 'antigravity' },
    detectedOnHost,
    chatAgents: ['antigravity'],
    hostChatAnswer: () => 'yes',
    chatProgram: () => 'available'
  })
  const model = { ...settled(rows), detection: { ...detection, detectedIds: detectedOnHost } }
  expect(model.detection.detectedIds).not.toContain('antigravity')
  const { onPick } = renderPicker(model, 'antigravity')
  fireEvent.click(screen.getByRole('combobox'))
  expect(option('Antigravity').getAttribute('aria-disabled')).not.toBe('true')
  expect(screen.queryByRole('button', { name: 'Start Antigravity in a terminal' })).toBeNull()
  expect(screen.queryByRole('option', { name: 'Antigravity (CLI)' })).toBeNull()
  fireEvent.pointerMove(option('Antigravity'))
  expect(option('Antigravity').getAttribute('aria-selected')).toBe('true')
  const input = screen.getByPlaceholderText('Search agents...')
  fireEvent.keyDown(input, { key: 'ArrowRight' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onPick).toHaveBeenCalledExactlyOnceWith('antigravity', 'chat')
})
