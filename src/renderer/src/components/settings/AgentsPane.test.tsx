import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CustomTuiAgentId, GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { getAgentAwakeDescription } from './agent-awake-copy'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import {
  AgentsPane,
  AGENTS_PANE_SEARCH_ENTRIES,
  buildCreateCustomAgentSettings,
  buildDeleteCustomAgentSettings,
  buildUpdateCustomAgentSettings
} from './AgentsPane'
import { matchesSettingsSearch } from './settings-search'

const detectedAgentsMock = vi.hoisted(() => ({
  detectedIds: ['claude'],
  isRefreshing: false,
  refresh: vi.fn()
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: detectedAgentsMock.detectedIds,
    isLoading: false,
    isRefreshing: detectedAgentsMock.isRefreshing,
    refresh: detectedAgentsMock.refresh
  })
}))

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

function findSwitch(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props.role === 'switch') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('switch not found')
  }
  return found
}

describe('AgentsPane', () => {
  beforeEach(() => {
    detectedAgentsMock.detectedIds = ['claude']
    detectedAgentsMock.isRefreshing = false
    detectedAgentsMock.refresh.mockReset()
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

    const keepAwakeSwitch = findSwitch(element)
    expect(keepAwakeSwitch.props['aria-label']).toBe('Keep computer awake while agents are working')
    expect(keepAwakeSwitch.props['aria-checked']).toBe(false)

    const onClick = keepAwakeSwitch.props.onClick as () => void
    onClick()

    expect(updateSettings).toHaveBeenCalledWith({
      keepComputerAwakeWhileAgentsRun: true
    })
  })

  it('includes awake and sleep search metadata for the setting', () => {
    expect(matchesSettingsSearch('awake', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('sleep', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('lid', AGENTS_PANE_SEARCH_ENTRIES)).toBe(true)
  })

  it('renders custom agent presets in the agents pane', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      customTuiAgents: [
        {
          id: 'custom:wrapper-abc123',
          label: 'Wrapper CLI',
          command: 'wrapper --profile dev',
          detectCmd: 'wrapper',
          promptInjectionMode: 'stdin-after-start'
        }
      ]
    })

    expect(markup).toContain('Custom agents')
    expect(markup).toContain('Wrapper CLI')
    expect(markup).toContain('wrapper --profile dev')
    expect(markup).toContain('Detect command')
    expect(markup).toContain('Edit Wrapper CLI')
    expect(markup).toContain('Delete Wrapper CLI')
  })

  it('renders custom agent presets before installable agents', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      customTuiAgents: [
        {
          id: 'custom:wrapper-abc123',
          label: 'Wrapper CLI',
          command: 'wrapper',
          promptInjectionMode: 'stdin-after-start'
        }
      ]
    })

    expect(markup.indexOf('Custom agents')).toBeGreaterThan(-1)
    expect(markup.indexOf('Available to install')).toBeGreaterThan(-1)
    expect(markup.indexOf('Custom agents')).toBeLessThan(markup.indexOf('Available to install'))
  })

  it('generates a custom agent id from the saved draft name', () => {
    const created = buildCreateCustomAgentSettings(getDefaultSettings('/tmp'), {
      label: 'Codex Work Profile',
      command: 'codex --profile work',
      detectCmd: 'codex'
    })

    expect(created.customTuiAgents).toHaveLength(1)
    expect(created.customTuiAgents?.[0]).toMatchObject({
      label: 'Codex Work Profile',
      command: 'codex --profile work',
      detectCmd: 'codex',
      promptInjectionMode: 'stdin-after-start'
    })
    expect(created.customTuiAgents?.[0]?.id).toMatch(/^custom:codex-work-profile-[a-z0-9]{6}$/)
  })

  it('cascades default and command overrides when deleting a custom agent', () => {
    const customId: CustomTuiAgentId = 'custom:wrapper-abc123'
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      defaultTuiAgent: customId,
      agentCmdOverrides: {
        claude: 'claude',
        [customId]: 'wrapper-dev'
      },
      customTuiAgents: [
        {
          id: customId,
          label: 'Wrapper CLI',
          command: 'wrapper',
          promptInjectionMode: 'stdin-after-start'
        }
      ]
    }

    expect(buildDeleteCustomAgentSettings(settings, customId)).toEqual({
      customTuiAgents: [],
      defaultTuiAgent: null,
      agentCmdOverrides: {
        claude: 'claude'
      }
    })
  })

  it('updates only the selected custom agent and preserves its id', () => {
    const firstId: CustomTuiAgentId = 'custom:first-agent-abc123'
    const secondId: CustomTuiAgentId = 'custom:second-agent-def456'
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      customTuiAgents: [
        {
          id: firstId,
          label: 'First Agent',
          command: 'first',
          promptInjectionMode: 'stdin-after-start'
        },
        {
          id: secondId,
          label: 'Second Agent',
          command: 'second',
          promptInjectionMode: 'stdin-after-start'
        }
      ]
    }

    const updated = buildUpdateCustomAgentSettings(settings, secondId, {
      label: 'Second Agent Edited',
      command: 'second --edited',
      detectCmd: 'second'
    })

    expect(updated.customTuiAgents).toEqual([
      {
        id: firstId,
        label: 'First Agent',
        command: 'first',
        promptInjectionMode: 'stdin-after-start'
      },
      {
        id: secondId,
        label: 'Second Agent Edited',
        command: 'second --edited',
        detectCmd: 'second',
        promptInjectionMode: 'stdin-after-start'
      }
    ])
  })
})
