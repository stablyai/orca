// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { makeTab } from '@/store/slices/store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { useShallow } from 'zustand/react/shallow'
import { selectAgentRowsUnread } from './worktree-card-agent-ack-inputs'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

type Round = { elapsedMs: number; cpuMs: number; renders: number }
type Result = { active: boolean; listeners: number; rounds: Round[] }

const LEAF = '11111111-1111-4111-8111-111111111111'
const CARDS = Number(process.env.ORCA_BENCH_CARDS ?? 100)
const WRITES = Number(process.env.ORCA_BENCH_WRITES ?? 500)

it.skipIf(!process.env.ORCA_AGENT_ROWS_BENCH)(
  'measures mounted agent row subscriptions',
  () => {
    const original = useAppStore.getState()
    const tabsByWorktree = Object.fromEntries(
      Array.from({ length: CARDS }, (_, index) => {
        const worktreeId = `wt-${index}`
        return [worktreeId, [makeTab({ id: `tab-${index}`, worktreeId })]]
      })
    )
    const entries: Record<string, AgentStatusEntry> = {}
    for (let index = 0; index < CARDS; index += 1) {
      const paneKey = makePaneKey(`tab-${index}`, LEAF)
      entries[paneKey] = {
        paneKey,
        tabId: `tab-${index}`,
        worktreeId: `wt-${index}`,
        state: 'working',
        agentType: 'claude',
        prompt: 'Do work',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: []
      }
    }
    useAppStore.setState({
      tabsByWorktree,
      agentStatusByPaneKey: entries,
      unifiedTabsByWorktree: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      retainedAgentsByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      paneForegroundAgentByPaneKey: {}
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const results: Result[] = []
    try {
      // A visible compact card uses both hooks; hidden details keep only the inactive hook.
      for (const active of [true, false]) {
        let renders = 0
        function VisibleProbe({ index }: { index: number }) {
          const rows = useWorktreeAgentRows(`wt-${index}`, true)
          useWorktreeAgentRows(`wt-${index}`, false)
          useAppStore(useShallow((state) => selectAgentRowsUnread(state, rows)))
          renders += 1
          return null
        }
        function HiddenProbe({ index }: { index: number }) {
          useWorktreeAgentRows(`wt-${index}`, false)
          renders += 1
          return null
        }
        const Probe = active ? VisibleProbe : HiddenProbe
        const baselineListeners = readStoreListenerCount() ?? 0
        act(() =>
          root.render(
            Array.from({ length: CARDS }, (_, index) => <Probe key={index} index={index} />)
          )
        )
        const listeners = (readStoreListenerCount() ?? 0) - baselineListeners
        const rounds: Round[] = []
        for (let round = 0; round < 6; round += 1) {
          const beforeRenders = renders
          const cpuStart = process.cpuUsage()
          const start = performance.now()
          for (let index = 0; index < WRITES; index += 1) {
            const key = makePaneKey(`tab-${index % CARDS}`, LEAF)
            act(() => {
              const previous = useAppStore.getState().agentStatusByPaneKey
              useAppStore.setState({
                agentStatusByPaneKey: {
                  ...previous,
                  [key]: { ...previous[key], updatedAt: Date.now(), toolName: `tool-${index}` }
                }
              })
            })
          }
          const elapsedMs = performance.now() - start
          const cpu = process.cpuUsage(cpuStart)
          expect(renders - beforeRenders).toBe(active ? WRITES : 0)
          if (round > 0) {
            rounds.push({
              elapsedMs,
              cpuMs: (cpu.user + cpu.system) / 1000,
              renders: renders - beforeRenders
            })
          }
        }
        results.push({ active, listeners, rounds })
        act(() => root.render(null))
        expect(readStoreListenerCount()).toBe(baselineListeners)
      }
      const report = { cards: CARDS, writes: WRITES, results }
      console.log(JSON.stringify(report))
      if (process.env.ORCA_BENCH_OUTPUT) {
        writeFileSync(process.env.ORCA_BENCH_OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
      }
    } finally {
      act(() => root.unmount())
      container.remove()
      useAppStore.setState(original, true)
    }
  },
  120_000
)
