import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { AGENT_STATUS_HOOKS_TITLE } from './agent-status-hooks-copy'
import { getAgentAwakeDescription } from './agent-awake-copy'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentStatusHooksSetting, AgentsPane, AGENTS_PANE_SEARCH_ENTRIES } from './AgentsPane'
import { matchesSettingsSearch } from './settings-search'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function renderPane(settings: GlobalSettings): string {
  return renderToStaticMarkup(
    React.createElement(AgentsPane, {
      settings,
      updateSettings: vi.fn()
    })
  )
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findSwitch(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props.role === 'switch' && entry.props['aria-label'] === ariaLabel) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('switch not found')
  }
  return found
}

function findSwitchRow(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      entry.props.ariaLabel === ariaLabel &&
      typeof entry.props.checked === 'boolean' &&
      typeof entry.props.onChange === 'function'
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('switch row not found')
  }
  return found
}

describe('AgentsPane', () => {
  beforeEach(() => {
    useAppStore.setState({
      settingsSearchQuery: '',
      detectedAgentIds: ['claude'],
      isDetectingAgents: false,
      isRefreshingAgents: false
    })
  })

  it('renders the keep-awake toggle from settings', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Keep computer awake while agents are working')
    expect(markup).toContain(
      'Keeps this computer and display awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
    )
    expect(markup).toContain('aria-checked="false"')
  })

  it('describes Windows lid behavior according to the device', () => {
    expect(getAgentAwakeDescription('Windows')).toBe(
      "Keeps this computer and display awake while agents are working. Lid-close behavior follows this device's power settings."
    )
  })

  it('toggles the keep-awake setting with the next value', () => {
    const updateSettings = vi.fn()
    const element = AgentAwakeSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        keepComputerAwakeWhileAgentsRun: false
      },
      updateSettings
    })

    const keepAwakeSwitch = findSwitch(element, 'Keep computer awake while agents are working')
    expect(keepAwakeSwitch.props['aria-label']).toBe('Keep computer awake while agents are working')
    expect(keepAwakeSwitch.props['aria-checked']).toBe(false)

    const onClick = keepAwakeSwitch.props.onClick as () => void
    onClick()

    expect(updateSettings).toHaveBeenCalledWith({
      keepComputerAwakeWhileAgentsRun: true
    })
  })

  it('toggles the agent status hook setting with the next value', () => {
    const updateSettings = vi.fn()
    const element = AgentStatusHooksSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        agentStatusHooksEnabled: true
      },
      updateSettings
    })

    const statusSwitch = findSwitchRow(element, AGENT_STATUS_HOOKS_TITLE)
    expect(statusSwitch.props.checked).toBe(true)

    const onChange = statusSwitch.props.onChange as () => void
    onChange()

    expect(updateSettings).toHaveBeenCalledWith({
      agentStatusHooksEnabled: false
    })
  })

  it('includes awake and sleep search metadata for the setting', () => {
    expect(matchesSettingsSearch('awake', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('sleep', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('lid', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
  })

  it('includes hook search metadata for the status setting', () => {
    expect(matchesSettingsSearch('hooks', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('waiting', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('codex', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
  })
})
