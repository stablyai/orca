// @vitest-environment happy-dom
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import { SettingsContentScrollElementProvider } from './settings-content-scroll-element'
import { SshTargetList } from './SshTargetList'

vi.mock('./SshTargetCard', () => ({
  SshTargetCard: ({ target }: { target: SshTarget }) => <div data-ssh-row>{target.label}</div>
}))

// Match the 13,692-host generated config that caused the original crash.
const IMPORTED_HOST_COUNT = 13_692
const VIEWPORT_HEIGHT_PX = 600
const ROW_HEIGHT_PX = 52

function configTarget(index: number): SshTarget {
  const name = `node-${String(index).padStart(5, '0')}`
  return {
    id: `ssh-${index}`,
    label: name,
    configHost: name,
    host: `10.0.${Math.floor(index / 256) % 256}.${index % 256}`,
    port: 22,
    username: 'deploy',
    source: 'ssh-config'
  }
}

function SettingsScrollerHarness({ targets }: { targets: SshTarget[] }): ReactElement {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  return (
    <div className="overflow-y-auto" data-testid="settings-scroller" ref={setScroller}>
      <SettingsContentScrollElementProvider value={scroller}>
        <SshTargetList
          targets={targets}
          totalBySource={{ 'ssh-config': targets.length, manual: 0 }}
          connectionStates={new Map()}
          testingIds={new Set()}
          busyActionForTarget={() => undefined}
          selection={{
            selected: new Set(),
            click: vi.fn(),
            setGroup: vi.fn(),
            retain: vi.fn(),
            clear: vi.fn()
          }}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onTest={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          onServerChanged={vi.fn()}
        />
      </SettingsContentScrollElementProvider>
    </div>
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // Supply missing happy-dom layout: one scroller viewport, row-sized boxes elsewhere.
  const heightOf = (element: Element): number =>
    element.classList.contains('overflow-y-auto') ? VIEWPORT_HEIGHT_PX : ROW_HEIGHT_PX
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return heightOf(this)
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(0, 0, 640, heightOf(this))
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function rowLabels(): string[] {
  return Array.from(document.querySelectorAll('[data-ssh-row]'), (row) => row.textContent ?? '')
}

describe('the SSH host list with a very large imported config', () => {
  it('mounts only the rows near the viewport instead of one card per host', () => {
    act(() => {
      root.render(
        <SettingsScrollerHarness
          targets={Array.from({ length: IMPORTED_HOST_COUNT }, (_, index) => configTarget(index))}
        />
      )
    })
    const labels = rowLabels()
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThan(100)
    expect(labels[0]).toBe('node-00000')
  })

  it('still reaches the last host by scrolling, so no host is hidden', () => {
    act(() => {
      root.render(
        <SettingsScrollerHarness
          targets={Array.from({ length: IMPORTED_HOST_COUNT }, (_, index) => configTarget(index))}
        />
      )
    })
    const scroller = document.querySelector<HTMLDivElement>('[data-testid="settings-scroller"]')!
    act(() => {
      scroller.scrollTop = IMPORTED_HOST_COUNT * ROW_HEIGHT_PX
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(rowLabels()).toContain(`node-${IMPORTED_HOST_COUNT - 1}`)
    expect(rowLabels()).not.toContain('node-00000')
  })
})
