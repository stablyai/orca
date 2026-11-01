// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useWorktreeAgentDisplay } from './use-worktree-agent-display'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

describe('worktree agent display subscription', () => {
  it('ignores unrelated writes and bounds selection work to the mounted cards', () => {
    const original = useAppStore.getState()
    const operations: number[] = []
    try {
      for (const count of [10, 100]) {
        let reads = 0
        let renders = 0
        useAppStore.setState(
          {
            ...original,
            agentActivityDisplayMode: 'compact',
            get showAgentModels() {
              reads += 1
              return true
            }
          },
          true
        )
        function Card() {
          const display = useWorktreeAgentDisplay()
          renders += 1
          return <span>{String(display.showAgentModels)}</span>
        }
        const container = document.createElement('div')
        const root = createRoot(container)
        try {
          act(() => root.render(Array.from({ length: count }, (_, index) => <Card key={index} />)))
          renders = 0
          reads = 0
          act(() =>
            useAppStore.setState(
              {
                ...useAppStore.getState(),
                uiZoomLevel: original.uiZoomLevel + 1,
                get showAgentModels() {
                  reads += 1
                  return true
                }
              },
              true
            )
          )
          expect(renders).toBe(0)
          expect(reads).toBeLessThanOrEqual(count * 2)
          operations.push(reads)
          act(() => useAppStore.setState({ showAgentModels: false }))
          expect(renders).toBe(count)
          expect(container.textContent).toBe('false'.repeat(count))
          act(() => useAppStore.setState({ agentActivityDisplayMode: 'full' }))
          expect(renders).toBe(count * 2)
        } finally {
          act(() => root.unmount())
        }
      }
      expect(operations[1]).toBeLessThanOrEqual(operations[0] * 10)
    } finally {
      useAppStore.setState(original, true)
    }
  })
})
