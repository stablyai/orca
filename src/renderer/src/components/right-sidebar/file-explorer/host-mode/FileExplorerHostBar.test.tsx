// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FileExplorerHostBar } from './FileExplorerHostBar'
import type { FileExplorerHostMode } from './use-file-explorer-host-mode'

let root: Root
let container: HTMLDivElement

function hostMode(listing: boolean, showLoading: boolean): FileExplorerHostMode {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bar reads only these fields.
  return {
    active: true,
    hostLabel: 'Local Mac',
    exit: vi.fn(),
    browser: {
      listing: listing ? { resolvedPath: '/home/allen', entries: [], pathFlavor: 'posix' } : null,
      loading: true,
      showLoading,
      error: null,
      canNavigateUp: listing,
      navigate: vi.fn(),
      navigateUp: vi.fn(),
      refresh: vi.fn(),
      activateEntry: vi.fn(),
      reset: vi.fn()
    }
  } as unknown as FileExplorerHostMode
}

async function render(mode: FileExplorerHostMode): Promise<HTMLElement> {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <FileExplorerHostBar hostMode={mode} />
      </TooltipProvider>
    )
  })
  const bar = container.querySelector<HTMLElement>('[data-file-explorer-host-bar]')
  if (!bar) {
    throw new Error('host bar not rendered')
  }
  return bar
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('FileExplorerHostBar', () => {
  it('reserves the breadcrumb row so the first listing does not grow the bar', async () => {
    const before = await render(hostMode(false, false))
    const rowsBefore = before.children.length

    const after = await render(hostMode(true, false))

    expect(after.children.length).toBe(rowsBefore)
  })

  it('shows the refresh spinner only once loading has lasted', async () => {
    expect((await render(hostMode(true, false))).querySelector('.animate-spin')).toBeNull()
    expect((await render(hostMode(true, true))).querySelector('.animate-spin')).not.toBeNull()
  })
})
