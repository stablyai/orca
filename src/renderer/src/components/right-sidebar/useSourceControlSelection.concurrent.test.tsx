// @vitest-environment happy-dom

import { act, Suspense, startTransition, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import { useSourceControlSelection, type FlatEntry } from './useSourceControlSelection'

const OLD_ENTRY: FlatEntry = {
  key: 'unstaged::old.ts',
  area: 'unstaged',
  entry: { path: 'old.ts', area: 'unstaged', status: 'modified' }
}

const NEW_ENTRY: FlatEntry = {
  key: 'unstaged::new.ts',
  area: 'unstaged',
  entry: { path: 'new.ts', area: 'unstaged', status: 'modified' }
}

describe('useSourceControlSelection committed event state', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps the visible row callback while the next render is suspended', async () => {
    const openedOld = vi.fn<(entry: GitStatusEntry) => void>()
    const openedNew = vi.fn<(entry: GitStatusEntry) => void>()
    const neverResolves = new Promise<never>(() => {})
    let showNext!: () => void

    function SelectionHarness({ next }: { next: boolean }): React.JSX.Element {
      const containerRef = useRef<HTMLDivElement>(null)
      const selection = useSourceControlSelection({
        flatEntries: next ? [NEW_ENTRY] : [OLD_ENTRY],
        onOpenDiff: next ? openedNew : openedOld,
        containerRef
      })

      if (next) {
        throw neverResolves
      }

      return (
        <div ref={containerRef}>
          <button
            onClick={(event) => selection.handleSelect(event, OLD_ENTRY.key, OLD_ENTRY.entry)}
          >
            Open old row
          </button>
        </div>
      )
    }

    function App(): React.JSX.Element {
      const [next, setNext] = useState(false)
      showNext = () => startTransition(() => setNext(true))
      return (
        <Suspense fallback={<div>Loading next worktree</div>}>
          <SelectionHarness next={next} />
        </Suspense>
      )
    }

    await act(async () => root.render(<App />))
    await act(async () => {
      showNext()
      await Promise.resolve()
    })

    const visibleButton = container.querySelector('button')
    expect(visibleButton?.textContent).toBe('Open old row')
    visibleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(openedOld).toHaveBeenCalledWith(OLD_ENTRY.entry)
    expect(openedNew).not.toHaveBeenCalled()
  })
})
