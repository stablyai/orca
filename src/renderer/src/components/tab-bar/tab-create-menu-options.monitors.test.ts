import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSystemMonitorDescriptor } from '../../../../shared/system-monitors'

const { createTabMock, setActiveTabTypeMock, persistOrderMock } = vi.hoisted(() => ({
  createTabMock: vi.fn(() => ({ id: 'tab-monitor-1' })),
  setActiveTabTypeMock: vi.fn(),
  persistOrderMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      createTab: createTabMock,
      setActiveTabType: setActiveTabTypeMock
    })
  }
}))

vi.mock('@/lib/agent-session/launch/pane/launch-agent-tab-order', () => ({
  persistAgentLaunchTabOrder: persistOrderMock
}))

import {
  buildTabCreateMenuOptions,
  findMatchingTabCreateMenuOptions
} from './tab-create-menu-options'
import { launchSystemMonitorInNewTab } from '@/lib/launch-system-monitor-in-new-tab'

describe('system monitor create-menu options and launcher', () => {
  beforeEach(() => {
    createTabMock.mockClear()
    setActiveTabTypeMock.mockClear()
    persistOrderMock.mockClear()
  })

  it('indexes detected system and Docker monitors in the + search omnibox', () => {
    const monitors = [
      getSystemMonitorDescriptor('btop'),
      getSystemMonitorDescriptor('htop'),
      getSystemMonitorDescriptor('lazydocker'),
      getSystemMonitorDescriptor('docker-stats')
    ]
    const options = buildTabCreateMenuOptions({
      terminalOnly: false,
      hasNewBrowser: true,
      hasNewMarkdown: true,
      hasOpenMarkdown: true,
      hasSimulator: false,
      simulatorIsGoTo: false,
      systemMonitors: monitors
    })

    const dockerMatches = findMatchingTabCreateMenuOptions('docker', options)
    expect(dockerMatches.map((entry) => entry.id)).toEqual([
      'launch-monitor:lazydocker',
      'launch-monitor:docker-stats'
    ])

    const htopMatches = findMatchingTabCreateMenuOptions('htop', options)
    expect(htopMatches[0]?.id).toBe('launch-monitor:htop')
    expect(htopMatches[0]?.kind).toBe('launch-monitor')
  })

  it('spawns an interactive terminal tab labeled and queued with the monitor command', () => {
    const monitor = getSystemMonitorDescriptor('docker-stats')
    const result = launchSystemMonitorInNewTab({
      monitor,
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual({ tabId: 'tab-monitor-1' })
    expect(createTabMock).toHaveBeenCalledWith('wt-1', 'group-1', undefined, {
      quickCommandLabel: 'docker stats',
      pendingStartup: { command: 'docker stats' }
    })
    expect(setActiveTabTypeMock).toHaveBeenCalledWith('terminal', 'wt-1')
    expect(persistOrderMock).toHaveBeenCalledWith('wt-1', 'tab-monitor-1')
  })
})
