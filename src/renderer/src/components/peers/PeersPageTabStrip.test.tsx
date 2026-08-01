// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PeersFlatTab } from './peers-flat-tab-list'
import { PeersPageTabStrip } from './PeersPageTabStrip'

function makeTabs(): PeersFlatTab[] {
  return [
    {
      hostId: 'host-a',
      handle: 'a1',
      title: 'Shell A',
      hostLabel: 'host-a.local',
      isFirstOfHost: true
    },
    {
      hostId: 'host-a',
      handle: 'a2',
      title: 'Server A',
      hostLabel: 'host-a.local',
      isFirstOfHost: false
    },
    {
      hostId: 'host-b',
      handle: 'b1',
      title: 'Shell B',
      hostLabel: 'host-b.local',
      isFirstOfHost: true
    }
  ]
}

const mountedRoots: Root[] = []

async function renderStrip(
  props: Partial<React.ComponentProps<typeof PeersPageTabStrip>>
): Promise<{
  container: HTMLDivElement
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <PeersPageTabStrip
          tabs={makeTabs()}
          activeKey="host-a:a1"
          onSelect={vi.fn()}
          onReorder={() => {}}
          {...props}
        />
      </TooltipProvider>
    )
  })
  return { container }
}

describe('PeersPageTabStrip', () => {
  afterEach(() => {
    mountedRoots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('renders one tab per terminal without host labels (tabs are host-scoped)', async () => {
    const { container } = await renderStrip({})
    const triggers = Array.from(container.querySelectorAll('[role="tab"]'))
    expect(triggers.map((el) => el.textContent)).toEqual(['Shell A', 'Server A', 'Shell B'])
    // Why: the strip shows one host's sessions; host identity lives in the sidebar and header.
    expect(container.textContent).not.toContain('host-a.local')
  })

  it('marks the active tab', async () => {
    const { container } = await renderStrip({ activeKey: 'host-b:b1' })
    const active = container.querySelector('[role="tab"][aria-selected="true"]')
    expect(active?.textContent).toBe('Shell B')
  })

  it('still renders with a single tab for visual consistency', async () => {
    const single: PeersFlatTab[] = [
      {
        hostId: 'host-a',
        handle: 'a1',
        title: 'Shell A',
        hostLabel: 'host-a.local',
        isFirstOfHost: true
      }
    ]
    const { container } = await renderStrip({ tabs: single })
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
  })

  it('labels a title-less terminal instead of exposing its raw handle', async () => {
    const untitled: PeersFlatTab[] = [
      { hostId: 'host-a', handle: 'term_raw1', title: '', hostLabel: 'h', isFirstOfHost: true },
      {
        hostId: 'host-a',
        handle: 'term_raw2',
        title: 'Named',
        hostLabel: 'h',
        isFirstOfHost: false
      }
    ]
    const { container } = await renderStrip({ tabs: untitled })
    const triggers = Array.from(container.querySelectorAll('[role="tab"]'))
    expect(triggers[0]?.textContent).toBe('Untitled terminal')
    expect(container.textContent).not.toContain('term_raw1')
  })
})
