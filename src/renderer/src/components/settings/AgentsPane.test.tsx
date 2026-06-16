/* eslint-disable max-lines -- Why: Agents pane settings interactions share
   store-backed queue fixtures that are easier to audit beside the UI helper coverage. */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '../../store'
import { getAgentGeneratedTabTitlesTitle } from './agent-generated-tab-title-copy'
import { getAgentStatusHooksTitle } from './agent-status-hooks-copy'
import { getAgentAwakeDescription, getAgentAwakeTitle } from './agent-awake-copy'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import {
  AgentAvailabilityControl,
  AgentPermissionsSetting,
  AgentGeneratedTabTitlesSetting,
  AgentStatusHooksSetting,
  AgentsPane,
  getAgentsPaneSearchEntries,
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue
} from './AgentsPane'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

const detectedAgentsMock = vi.hoisted(() => ({
  detectedIds: ['claude'] as TuiAgent[] | null,
  refresh: vi.fn()
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: detectedAgentsMock.detectedIds,
    isLoading: detectedAgentsMock.detectedIds === null,
    isRefreshing: false,
    refresh: detectedAgentsMock.refresh
  })
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function flushPromiseQueue(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function renderPane(
  settings: GlobalSettings,
  props: Partial<React.ComponentProps<typeof AgentsPane>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AgentsPane, {
        settings,
        updateSettings: vi.fn(),
        ...props
      })
    )
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
    detectedAgentsMock.detectedIds = ['claude']
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

    expect(markup).not.toContain('Agent location')
    expect(markup).not.toContain('aria-label="Agent location"')
    expect(markup).toContain('Keep computer awake while agents are working')
    expect(markup).toContain(
      'Keeps this computer and display awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
    )
    expect(markup).toContain('aria-checked="false"')
  })

  it('keeps the agent location aligned with a WSL default terminal while capabilities load', () => {
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        terminalWindowsShell: 'wsl.exe'
      },
      { wslSupportedPlatform: true, wslCapabilitiesLoading: true }
    )

    expect(markup).toContain('Show installed agents from WSL default.')
    expect(markup).toContain('role="radio" aria-checked="true" disabled=""')
  })

  it('hides the WSL agent location controls on platforms without WSL support', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      localAgentRuntime: 'wsl',
      terminalWindowsShell: 'wsl.exe'
    })

    expect(markup).not.toContain('Agent location')
    expect(markup).not.toContain('aria-label="Agent location"')
    expect(markup).not.toContain('WSL is not available on this machine.')
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

    const keepAwakeTitle = getAgentAwakeTitle()
    const keepAwakeSwitch = findSwitch(element, keepAwakeTitle)
    expect(keepAwakeSwitch.props['aria-label']).toBe(keepAwakeTitle)
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

    const statusSwitch = findSwitchRow(element, getAgentStatusHooksTitle())
    expect(statusSwitch.props.checked).toBe(true)

    const onChange = statusSwitch.props.onChange as () => void
    onChange()

    expect(updateSettings).toHaveBeenCalledWith({
      agentStatusHooksEnabled: false
    })
  })

  it('toggles generated tab titles with the next value', () => {
    const updateSettings = vi.fn()
    const element = AgentGeneratedTabTitlesSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        tabAutoGenerateTitle: false
      },
      updateSettings
    })

    const generatedTitleSwitch = findSwitchRow(element, getAgentGeneratedTabTitlesTitle())
    expect(generatedTitleSwitch.props.checked).toBe(false)

    const onChange = generatedTitleSwitch.props.onChange as () => void
    onChange()

    expect(updateSettings).toHaveBeenCalledWith({
      tabAutoGenerateTitle: true
    })
  })

  it('includes awake and sleep search metadata for the setting', () => {
    expect(matchesSettingsSearch('awake', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('sleep', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('lid', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes hook search metadata for the status setting', () => {
    expect(matchesSettingsSearch('hooks', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('waiting', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('codex', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes generated title search metadata', () => {
    expect(matchesSettingsSearch('generated title', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('stable session', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes enable and hide search metadata for agent visibility', () => {
    expect(matchesSettingsSearch('disable', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('hide', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes agent permission search metadata', () => {
    expect(matchesSettingsSearch('permission', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('yolo', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('manual', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('applies the selected agent permission mode from settings without a mixed segment', () => {
    const onChange = vi.fn()
    const element = AgentPermissionsSetting({ mode: 'mixed', onChange })
    const props = element.props.children.props.action.props as {
      value: 'yolo'
      onChange: (value: 'yolo' | 'manual' | 'mixed') => void
      options: { value: string }[]
    }

    expect(props.value).toBe('yolo')
    expect(props.options.map((option) => option.value)).toEqual(['yolo', 'manual'])
    props.onChange('mixed')
    expect(onChange).not.toHaveBeenCalled()

    props.onChange('manual')
    expect(onChange).toHaveBeenCalledWith('manual')
  })

  it('keeps catalog agent ids, labels, and commands discoverable in settings search', () => {
    for (const agent of AGENT_CATALOG) {
      expect(matchesSettingsSearch(agent.id, getAgentsPaneSearchEntries())).toBe(true)
      expect(matchesSettingsSearch(agent.label, getAgentsPaneSearchEntries())).toBe(true)
      expect(matchesSettingsSearch(agent.cmd, getAgentsPaneSearchEntries())).toBe(true)
    }

    expect(matchesSettingsSearch('GitHub Copilot', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('open claude', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('command-code', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('command code', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('agy', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('cursor-agent', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('renders per-agent availability as labeled status choices without row explanation copy', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      disabledTuiAgents: ['claude']
    })

    expect(markup).toContain('aria-label="Claude availability"')
    expect(markup).toContain('Enabled')
    expect(markup).toContain('Disabled')
    expect(markup).not.toContain('Shown in launch and default choices.')
    expect(markup).not.toContain('Install to use in launch and default choices.')
    expect(markup).not.toContain('Hidden from launch and default choices.')
    expect(markup).not.toContain('aria-label="Enable Claude"')
    expect(markup).not.toContain('aria-label="Disable Claude"')
  })

  it('only toggles agent availability when the segmented value changes', () => {
    const onSetEnabled = vi.fn()
    const control = AgentAvailabilityControl({
      label: 'Claude',
      isEnabled: true,
      onSetEnabled
    })
    const props = control.props as {
      value: 'enabled' | 'disabled'
      onChange: (value: 'enabled' | 'disabled') => void
      ariaLabel: string
    }

    expect(props.value).toBe('enabled')
    expect(props.ariaLabel).toBe('Claude availability')

    props.onChange('enabled')
    expect(onSetEnabled).not.toHaveBeenCalled()

    props.onChange('disabled')
    expect(onSetEnabled).toHaveBeenCalledWith(false)
  })

  it('clears the default agent when disabling that agent', () => {
    expect(
      buildAgentAvailabilitySettingsUpdate(
        {
          defaultTuiAgent: 'claude',
          disabledTuiAgents: []
        },
        'claude',
        false
      )
    ).toEqual({
      disabledTuiAgents: ['claude'],
      defaultTuiAgent: null
    })
  })

  it('keeps the default setting untouched when re-enabling an agent', () => {
    expect(
      buildAgentAvailabilitySettingsUpdate(
        {
          defaultTuiAgent: null,
          disabledTuiAgents: ['claude']
        },
        'claude',
        true
      )
    ).toEqual({
      disabledTuiAgents: []
    })
  })

  it('includes agent location search metadata', () => {
    expect(matchesSettingsSearch('wsl', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('windows', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('serializes rapid availability writes against the latest settings snapshot', async () => {
    const queueAvailabilityUpdate = createAgentAvailabilityUpdateQueue()
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      defaultTuiAgent: null,
      disabledTuiAgents: []
    }
    const writes: Deferred[] = []
    const updates: Partial<GlobalSettings>[] = []

    useAppStore.setState({ settings })
    const updateSettings = vi.fn((update: Partial<GlobalSettings>) => {
      updates.push(update)
      const nextSettings = {
        ...(useAppStore.getState().settings ?? settings),
        ...update
      }
      const write = createDeferred()
      writes.push(write)
      return write.promise.then(() => {
        useAppStore.setState({ settings: nextSettings })
      })
    })

    const firstWrite = queueAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'claude',
      enabled: false
    })
    const secondWrite = queueAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'codex',
      enabled: false
    })

    await flushPromiseQueue()
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updates[0]).toMatchObject({ disabledTuiAgents: ['claude'] })

    writes[0].resolve()
    await firstWrite
    await flushPromiseQueue()

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updates[1]).toMatchObject({ disabledTuiAgents: ['claude', 'codex'] })

    writes[1].resolve()
    await secondWrite
  })

  it('keeps repeated queued availability requests idempotent', async () => {
    const queueAvailabilityUpdate = createAgentAvailabilityUpdateQueue()
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      defaultTuiAgent: null,
      disabledTuiAgents: []
    }
    const writes: Deferred[] = []
    const updates: Partial<GlobalSettings>[] = []

    useAppStore.setState({ settings })
    const updateSettings = vi.fn((update: Partial<GlobalSettings>) => {
      updates.push(update)
      const nextSettings = {
        ...(useAppStore.getState().settings ?? settings),
        ...update
      }
      const write = createDeferred()
      writes.push(write)
      return write.promise.then(() => {
        useAppStore.setState({ settings: nextSettings })
      })
    })

    const firstWrite = queueAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'claude',
      enabled: false
    })
    const secondWrite = queueAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'claude',
      enabled: false
    })

    await flushPromiseQueue()
    writes[0].resolve()
    await firstWrite
    await flushPromiseQueue()

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updates[1]).toMatchObject({ disabledTuiAgents: ['claude'] })

    writes[1].resolve()
    await secondWrite
  })
})
