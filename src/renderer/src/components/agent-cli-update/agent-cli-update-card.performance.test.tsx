// @vitest-environment happy-dom
// Perf contract (#48610, agent CLI update card): each path below did quadratic or hidden work. Unrelated
// store writes re-joined every checked host with the host list (a host's last-used time must not re-render
// readers either, and with no other host's updates a catalog change must not read it at all), a dismissed
// offer scanned the seen list per release, and a collapsed list built and mounted every row.
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentCliUpdateHost } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import type { AppState } from '@/store/types'
import { AGENT_CLI_UPDATE_AGENTS } from '../../../../shared/agent-launch/installation/agent-cli-update'
import type { AgentCliUpdateRow } from '../status-bar/updates/AgentCliUpdateList'
import { agentCliUpdateCardWait } from './agent-cli-update-card-offer'
import { AgentCliUpdateToast } from './AgentCliUpdateToast'
import type { AgentCliUpdateToastItem } from './AgentCliUpdateToastList'
import { useAgentCliUpdateGroups } from './use-agent-cli-update-groups'

const SIZES = [12, 120]
const initial = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

/** A copy of `values` whose element reads each bump `counter.reads`. */
function countedList<T>(values: readonly T[], counter: { reads: number }): T[] {
  const list: T[] = []
  values.forEach((value, index) =>
    Object.defineProperty(list, index, {
      enumerable: true,
      get: () => {
        counter.reads++
        return value
      }
    })
  )
  return list
}

function agentAt(index: number): AgentCliUpdateRow['agent'] {
  return AGENT_CLI_UPDATE_AGENTS[index % AGENT_CLI_UPDATE_AGENTS.length]
}

describe('agent CLI update card work', () => {
  it.each(SIZES)('reads no host list on unrelated store writes with %i checked hosts', (hosts) => {
    const counter = { reads: 0 }
    const environments = Array.from({ length: hosts }, (_, index) => ({
      id: `env-${index}`,
      name: `Host ${index}`
    }))
    // Checked hosts the card keeps with nothing to offer, as each paired host's answer leaves them, and
    // one with an offer so the names are needed.
    const checked = new Map<string, AgentCliUpdateHost>(
      environments.map((environment, index) => [
        environment.id,
        {
          updates:
            index === 0
              ? [
                  {
                    agent: 'claude',
                    installedVersion: '1',
                    latestVersion: '2',
                    command: 'claude update',
                    runnable: true
                  }
                ]
              : [],
          runs: {}
        }
      ])
    )
    useAppStore.setState({
      agentCliUpdates: checked,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id, name and length.
      runtimeEnvironments: countedList(
        environments,
        counter
      ) as unknown as AppState['runtimeEnvironments']
    })
    const { result } = renderHook(() => useAgentCliUpdateGroups())
    expect(result.current[0]?.label).toBe('Host 0')
    counter.reads = 0
    for (let write = 0; write < 10; write++) {
      act(() => useAppStore.setState({ sidebarWidth: 200 + write }))
    }
    expect(counter.reads).toBe(0)
  })

  it.each(SIZES)(
    'reads no host list on catalog changes with %i hosts and no remote rows',
    (hosts) => {
      const counter = { reads: 0 }
      const environments = Array.from({ length: hosts }, (_, index) => ({
        id: `env-${index}`,
        name: `Host ${index}`
      }))
      const catalog = (): AppState['runtimeEnvironments'] =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id, name and length.
        countedList(environments, counter) as unknown as AppState['runtimeEnvironments']
      useAppStore.setState({
        // A remote host keeps its entry once its updates are run or rechecked away.
        agentCliUpdates: new Map([
          ['', { updates: [], runs: {} }],
          ['env-0', { updates: [], runs: {} }]
        ]),
        runtimeEnvironments: catalog()
      })
      const { result } = renderHook(() => useAgentCliUpdateGroups())
      expect(result.current).toEqual([])
      for (let refresh = 0; refresh < 10; refresh++) {
        act(() => useAppStore.setState({ runtimeEnvironments: catalog() }))
      }
      expect(counter.reads).toBe(0)
    }
  )

  it.each(SIZES)('re-renders no reader when a catalog change keeps all %i host names', (hosts) => {
    const environments = Array.from({ length: hosts }, (_, index) => ({
      id: `env-${index}`,
      name: `Host ${index}`,
      lastUsedAt: 1
    }))
    const offered = new Map<string, AgentCliUpdateHost>(
      environments.map((environment) => [
        environment.id,
        {
          updates: [
            {
              agent: 'claude',
              installedVersion: '1',
              latestVersion: '2',
              command: 'claude update',
              runnable: true
            }
          ],
          runs: {}
        }
      ])
    )
    const catalog = (lastUsedAt: number, renamed = ''): AppState['runtimeEnvironments'] =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id, name and length.
      environments.map((environment, index) => ({
        ...environment,
        name: index === 0 && renamed ? renamed : environment.name,
        lastUsedAt
      })) as unknown as AppState['runtimeEnvironments']
    useAppStore.setState({ agentCliUpdates: offered, runtimeEnvironments: catalog(1) })
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useAgentCliUpdateGroups()
    })
    const before = renders
    for (let refresh = 2; refresh < 12; refresh++) {
      act(() => useAppStore.setState({ runtimeEnvironments: catalog(refresh) }))
    }
    expect(renders - before).toBe(0)
    act(() => useAppStore.setState({ runtimeEnvironments: catalog(12, 'Renamed') }))
    expect(result.current[0]?.label).toBe('Renamed')
  })

  it.each(SIZES)('reads the seen list once to hold back %i dismissed releases', (count) => {
    const keys = Array.from({ length: count }, (_, index) => `env\nclaude\n1.0.${index}`)
    const counter = { reads: 0 }
    const memory = { closedAt: 0, seen: countedList(keys, counter) }
    expect(agentCliUpdateCardWait(keys, memory, 1)).toBeNull()
    expect(counter.reads).toBe(count)
  })

  it.each(SIZES)(
    'builds and mounts no rows for %i running CLIs while the list is collapsed',
    (count) => {
      let builds = 0
      const items = (): AgentCliUpdateToastItem[] => {
        builds++
        return Array.from({ length: count }, (_, index) => ({
          key: `env-${index}\n${agentAt(index)}`,
          hostLabel: `Host ${index}`,
          agent: agentAt(index),
          from: '1',
          to: '2',
          status: 'running',
          manualCommand: null
        }))
      }
      const toast = (listOpen: boolean): React.JSX.Element => (
        <AgentCliUpdateToast
          view="updating"
          total={count}
          settled={0}
          failed={0}
          canUpdate={false}
          items={items}
          listOpen={listOpen}
          onToggleList={() => {}}
          onClose={() => {}}
          onUpdate={() => {}}
          onRetry={() => {}}
        />
      )
      const { container, rerender } = render(toast(false))
      expect(builds).toBe(0)
      // The header's own spinner only.
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(1)
      rerender(toast(true))
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(count + 1)
    }
  )
})
