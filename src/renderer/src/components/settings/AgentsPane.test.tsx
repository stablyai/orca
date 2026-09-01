// @vitest-environment happy-dom
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/constants'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import { buildLocalCatalogSnapshot } from './agent-catalog-snapshot.fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '../../store'
import { getAgentGeneratedTabTitlesTitle } from './agent-generated-tab-title-copy'
import { getAgentStatusHooksTitle } from './agent-status-hooks-copy'
import { getAgentAwakeDescription, getAgentAwakeTitle } from './agent-awake-copy'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import type * as AgentRuntimeSettingModule from './AgentRuntimeSetting'
import {
  AgentPermissionsSetting,
  AgentGeneratedTabTitlesSetting,
  AgentStatusHooksSetting,
  AgentsPane,
  getAgentsPaneSearchEntries
} from './AgentsPane'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

const detectedAgentsMock = vi.hoisted(() => ({
  detectedIds: ['claude'] as TuiAgent[] | null,
  isLoading: false,
  detectionFailed: false,
  refresh: vi.fn(),
  lastTarget: undefined as unknown
}))
const agentRuntimeSettingMock = vi.hoisted(() => ({
  lastRefresh: null as (() => Promise<unknown>) | null
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (target: unknown) => {
    detectedAgentsMock.lastTarget = target
    return {
      detectedIds: detectedAgentsMock.detectedIds,
      isLoading: detectedAgentsMock.isLoading,
      detectionFailed: detectedAgentsMock.detectionFailed,
      isRefreshing: false,
      refresh: detectedAgentsMock.refresh
    }
  }
}))

vi.mock('./AgentRuntimeSetting', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentRuntimeSettingModule>()
  return {
    ...actual,
    AgentRuntimeSetting: (props: React.ComponentProps<typeof actual.AgentRuntimeSetting>) => {
      agentRuntimeSettingMock.lastRefresh = props.refresh
      return actual.AgentRuntimeSetting(props)
    }
  }
})

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
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
  if (element.props?.control) {
    visit(element.props.control, cb)
  }
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

function findSegmentedControl(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props.ariaLabel === ariaLabel && typeof entry.props.onChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('segmented control not found')
  }
  return found
}

describe('AgentsPane', () => {
  beforeEach(() => {
    detectedAgentsMock.detectedIds = ['claude']
    detectedAgentsMock.isLoading = false
    detectedAgentsMock.detectionFailed = false
    detectedAgentsMock.refresh.mockReset()
    detectedAgentsMock.lastTarget = undefined
    agentRuntimeSettingMock.lastRefresh = null
    useAppStore.setState({
      settingsSearchQuery: '',
      detectedAgentIds: ['claude'],
      isDetectingAgents: false,
      isRefreshingAgents: false,
      runtimeEnvironments: []
    } as never)
  })

  it('detects agents locally when no active remote server is set', () => {
    renderPane(getDefaultSettings('/tmp'))

    expect(detectedAgentsMock.lastTarget).toEqual({ kind: 'local' })
  })

  it('scopes agent detection to the active remote server', () => {
    // Repro for the "Remote Server lists local agents" bug: with an Active
    // Server selected, the Installed list must probe that server's PATH.
    // Why the mutation: renderToStaticMarkup makes useSyncExternalStore read
    // the zustand SERVER snapshot (getInitialState), so setState is invisible
    // here — patch the initial-state object itself and restore it after.
    const initialState = useAppStore.getInitialState() as unknown as {
      runtimeEnvironments: unknown
    }
    const priorRuntimeEnvironments = initialState.runtimeEnvironments
    initialState.runtimeEnvironments = [{ id: 'env-1', name: 'Coder' }]

    try {
      const markup = renderPane({
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-1'
      })

      expect(detectedAgentsMock.lastTarget).toEqual({ kind: 'runtime', environmentId: 'env-1' })
      expect(markup).toContain('on Coder')
    } finally {
      initialState.runtimeEnvironments = priorRuntimeEnvironments
    }
  })

  it('shows a retryable error when initial remote detection fails', () => {
    detectedAgentsMock.detectedIds = null
    detectedAgentsMock.isLoading = false
    detectedAgentsMock.detectionFailed = true

    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      activeRuntimeEnvironmentId: 'env-1'
    })

    expect(markup).toContain('Couldn’t detect installed agents')
    expect(markup).toContain('Retry')
    expect(markup).not.toContain('Detecting installed agents…')
  })

  it('does not flash a failure before the initial detection effect starts', () => {
    detectedAgentsMock.detectedIds = null
    detectedAgentsMock.isLoading = false
    detectedAgentsMock.detectionFailed = false

    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Detecting installed agents…')
    expect(markup).not.toContain('Couldn’t detect installed agents')
  })

  it('keeps Windows runtime changes scoped to the local agent refresh', () => {
    renderPane(
      {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-1'
      },
      { wslSupportedPlatform: true, wslAvailable: true, wslDistros: ['Ubuntu'] }
    )

    expect(agentRuntimeSettingMock.lastRefresh).toBe(
      useAppStore.getInitialState().refreshDetectedAgents
    )
    expect(agentRuntimeSettingMock.lastRefresh).not.toBe(detectedAgentsMock.refresh)
  })

  it('renders the keep-awake modes from settings', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).not.toContain('Agent location')
    expect(markup).not.toContain('Agent runtime')
    expect(markup).not.toContain('aria-label="Agent runtime"')
    expect(markup).toContain('Keep computer awake')
    expect(markup).toContain(
      'Choose On, Agent, or Off. Agent mode stays awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
    )
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('>Agent<')
  })

  it('hides desktop-only awake modes in paired web clients', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    try {
      expect(renderPane(getDefaultSettings('/tmp'))).not.toContain('Keep computer awake')
      expect(
        matchesSettingsSearch('awake', getAgentsPaneSearchEntries({ includeAgentAwake: false }))
      ).toBe(false)
    } finally {
      delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    }
  })

  it('renders the agent runtime control on Windows-class hosts', () => {
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      },
      { wslSupportedPlatform: true, wslAvailable: true, wslDistros: ['Ubuntu'] }
    )

    expect(markup).not.toContain('Agent location')
    expect(markup).toContain('Agent runtime')
    expect(markup).toContain('aria-label="Agent runtime"')
    expect(markup).toContain('Detect and launch agents in Ubuntu via WSL')
  })

  it('hides the WSL agent location controls on platforms without WSL support', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      localAgentRuntime: 'wsl',
      terminalWindowsShell: 'wsl.exe'
    })

    expect(markup).not.toContain('Agent location')
    expect(markup).not.toContain('aria-label="Agent location"')
    expect(markup).not.toContain('Agent runtime')
    expect(markup).not.toContain('aria-label="Agent runtime"')
    expect(markup).not.toContain('WSL is not available on this machine.')
  })

  it('updates the global project runtime when changing agent runtime', async () => {
    const updateSettings = vi.fn()
    const element = AgentRuntimeSetting({
      settings: getDefaultSettings('/tmp'),
      updateSettings,
      refresh: detectedAgentsMock.refresh,
      wslSupportedPlatform: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      wslCapabilitiesLoading: false
    })
    const control = findSegmentedControl(element, 'Agent runtime')
    const onChange = control.props.onChange as (value: 'windows-host' | 'wsl') => void

    onChange('wsl')
    await flushPromiseQueue()

    expect(updateSettings).toHaveBeenCalledWith({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(detectedAgentsMock.refresh).toHaveBeenCalledTimes(1)
  })

  it('describes Windows lid behavior according to the device', () => {
    expect(getAgentAwakeDescription('Windows')).toBe(
      "Choose On, Agent, or Off. Agent mode stays awake while agents are working; lid-close behavior follows this device's power settings."
    )
  })

  it('updates the keep-awake mode with its legacy fallback', () => {
    const updateSettings = vi.fn()
    const element = AgentAwakeSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        keepComputerAwakeWhileAgentsRun: false
      },
      updateSettings
    })

    const keepAwakeTitle = getAgentAwakeTitle()
    const keepAwakeControl = findSegmentedControl(element, keepAwakeTitle)
    expect(keepAwakeControl.props.value).toBe('off')

    const onChange = keepAwakeControl.props.onChange as (mode: 'auto') => void
    onChange('auto')

    expect(updateSettings).toHaveBeenCalledWith({
      computerAwakeMode: 'auto',
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

  it('includes agent runtime search metadata', () => {
    expect(matchesSettingsSearch('agent runtime', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('agent location', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('installed agents in wsl', getAgentsPaneSearchEntries())).toBe(
      true
    )
  })

  it('renders authoring controls without a read-only notice on the desktop host', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).not.toContain('Agent settings are managed on the desktop')
    expect(markup).not.toContain('disabled=""')
  })

  it('renders a read-only notice and disables authoring on paired clients', () => {
    const markup = renderPane(getDefaultSettings('/tmp'), { readOnly: true })

    expect(markup).toContain('Agent settings are managed on the desktop')
    expect(markup).toContain('use the Orca desktop app')
    // The whole authoring surface is wrapped in a disabled fieldset so no control
    // is interactive; the host also rejects remote authoring (defense-in-depth).
    expect(markup).toContain('<fieldset')
    expect(markup).toContain('disabled=""')
  })
})

describe('empty agent detection must not cost the saved default (#15256)', () => {
  // The default picker moved into the async AgentCatalogSection and the saved
  // default now lives in the local catalog snapshot, so these tests hydrate the
  // snapshot the way AgentCatalogSection.test.tsx does, holding detection empty
  // for the whole render.
  const isRowElement = (el: HTMLElement): boolean =>
    typeof el.hasAttribute === 'function' && el.hasAttribute('data-agent-catalog-row')

  let restoreDom: (() => void) | undefined
  let savedDetectedIds: typeof detectedAgentsMock.detectedIds = null

  beforeEach(() => {
    savedDetectedIds = detectedAgentsMock.detectedIds
    detectedAgentsMock.detectedIds = []
    // @tanstack/react-virtual measures via offsetHeight/getBoundingClientRect,
    // which happy-dom reports as zero; feed the container a viewport and rows
    // their estimate so catalog rows actually mount.
    const rect = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      const height = isRowElement(this) ? 52 : 500
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 400,
        bottom: height,
        width: 400,
        height,
        toJSON() {}
      }
    }
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return isRowElement(this) ? 52 : 500
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 400
    })
    restoreDom = () => {
      HTMLElement.prototype.getBoundingClientRect = rect
      if (offsetHeight) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
      }
      if (offsetWidth) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      }
    }
  })

  afterEach(() => {
    cleanup()
    restoreDom?.()
    detectedAgentsMock.detectedIds = savedDetectedIds
    delete (window as { api?: unknown }).api
  })

  const renderHydratedPane = (snapshot: LocalAgentCatalogSnapshot): void => {
    ;(window as unknown as { api: unknown }).api = {
      settings: {
        agentCatalog: { getLocal: vi.fn().mockResolvedValue(snapshot) },
        onChanged: () => () => {}
      }
    }
    render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AgentsPane, {
          settings: getDefaultSettings('/tmp'),
          updateSettings: vi.fn()
        })
      )
    )
  }

  it('does not present Auto as the active choice while an agent is stored', async () => {
    // The saved default must stay the visible selection: presenting Auto as the
    // active choice while `defaultAgent: 'claude'` is stored made the
    // already-selected control destructive — one click erased the setting, and
    // later successful detection did not bring it back.
    renderHydratedPane(buildLocalCatalogSnapshot({ defaultAgent: 'claude' }))
    const trigger = await screen.findByRole('combobox')
    expect(trigger.textContent).toContain('Claude')
    expect(trigger.textContent).not.toContain('Auto')
  })

  it('still offers the stored agent so the choice can be kept', async () => {
    // With zero detected the stored agent must stay visible (as Not installed),
    // not vanish and leave the saved value unrecoverable through the UI.
    renderHydratedPane(buildLocalCatalogSnapshot({ defaultAgent: 'claude' }))
    const labels = await screen.findAllByText('Claude')
    const row = labels
      .map((el) => el.closest('[data-agent-catalog-row]'))
      .find((el): el is HTMLElement => el instanceof HTMLElement)
    expect(row, 'no catalog row labelled Claude').toBeTruthy()
    expect(within(row as HTMLElement).getByText('Not installed')).toBeTruthy()
  })

  it('keeps a Refresh control reachable when nothing is detected', async () => {
    renderHydratedPane(buildLocalCatalogSnapshot({}))
    expect(await screen.findByText('Refresh')).toBeTruthy()
  })
})
