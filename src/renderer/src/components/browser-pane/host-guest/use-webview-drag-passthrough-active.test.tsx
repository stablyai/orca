// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DragPassthroughModule from './webview-drag-passthrough'

/** Real behaviour, with enrolment counted: a subscriber that never drops out of the shared
 *  module-level set is otherwise invisible — the set is not enumerable from outside. */
const enrolment = vi.hoisted(() => ({ live: 0 }))

vi.mock('./webview-drag-passthrough', async (importActual) => {
  const actual = await importActual<typeof DragPassthroughModule>()
  return {
    ...actual,
    registerWebviewDragPassthroughSurface: (
      surface: DragPassthroughModule.WebviewDragPassthroughSurface
    ) => {
      enrolment.live += 1
      const release = actual.registerWebviewDragPassthroughSurface(surface)
      let released = false
      return () => {
        if (!released) {
          released = true
          enrolment.live -= 1
        }
        release()
      }
    }
  }
})

import { acquireWebviewsDragPassthrough } from './webview-drag-passthrough'
import { useWebviewDragPassthroughActive } from './use-webview-drag-passthrough-active'

const openReleases: (() => void)[] = []

function startDrag(): () => void {
  let release!: () => void
  act(() => {
    release = acquireWebviewsDragPassthrough()
  })
  openReleases.push(release)
  return () => act(() => release())
}

function Probe(): string {
  return String(useWebviewDragPassthroughActive())
}

afterEach(() => {
  for (const release of openReleases.splice(0)) {
    release()
  }
  cleanup()
})

describe.each([
  ['plain', (tree: ReactNode) => <>{tree}</>],
  ['StrictMode', (tree: ReactNode) => <StrictMode>{tree}</StrictMode>]
])('useWebviewDragPassthroughActive (%s)', (_half, wrap) => {
  it('reports the drag state and re-renders on both edges', () => {
    const view = render(wrap(<Probe />))
    expect(view.container.textContent).toBe('false')

    const endDrag = startDrag()
    expect(view.container.textContent).toBe('true')

    endDrag()
    expect(view.container.textContent).toBe('false')
  })

  it('drops out of the shared surface set when the subscriber unmounts', () => {
    const before = enrolment.live
    const view = render(wrap(<Probe />))
    expect(enrolment.live).toBe(before + 1)

    view.unmount()

    expect(enrolment.live).toBe(before)
  })
})
