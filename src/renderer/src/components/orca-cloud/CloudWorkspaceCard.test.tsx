// @vitest-environment happy-dom

import React, { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import { setCloudCardDetailsOpen } from './use-cloud-workspace-card-state'
import { cloudCardSideOffset } from './CloudWorkspaceMark'

afterEach(() => {
  cleanup()
  setCloudCardDetailsOpen(false)
})

const noop = (): void => {}
const actions = { onWake: noop, onRestart: noop, onArchive: noop, onUnarchive: noop, onSleep: noop }

const running: HostedWorkspaceStatus = {
  state: 'ready',
  metrics: {
    cpuPercent: 13,
    cpus: 8,
    load1: 0,
    memTotalBytes: 16.8e9,
    memUsedBytes: 1.8e9,
    diskTotalBytes: 34e9,
    diskUsedBytes: 6e9,
    uptimeSeconds: 60,
    oomKills: 0,
    lastOomVictim: null,
    orcadAlive: true
  },
  uptimeMs: 60_000,
  usage: { totalMs: 0, centsPerHour: 100, costCents: 0 },
  archive: null,
  checkedAt: 1
}

function card(
  state: 'running' | 'sleeping',
  extra: Partial<React.ComponentProps<typeof CloudWorkspaceStatusPanel>> = {}
) {
  return (
    <CloudWorkspaceStatusPanel
      workspaceId="ws"
      name="fix-login"
      state={state}
      entry={{
        status: state === 'running' ? running : { ...running, state: 'sleeping', metrics: null },
        loading: false,
        error: null,
        fetchedAt: 1
      }}
      pending={undefined}
      actions={actions}
      attention={null}
      asOf={null}
      {...extra}
    />
  )
}

describe('calm cloud workspace card', () => {
  it('running: one usage line, no attention row, Sleep as the one visible action', () => {
    const { container } = render(card('running'))
    const text = container.textContent ?? ''
    expect(text).toContain('CPU 13% · Memory 1.8 / 16 GB')
    expect(text).not.toContain('Agents and secrets')
    expect(container.querySelector('[data-cloud-card-attention]')).toBeNull()
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).toContain('Sleep')
    expect(buttons).not.toContain('Archive')
    expect(buttons).not.toContain('Restart')
  })

  it('asleep: no usage line, Wake', () => {
    const { container } = render(card('sleeping'))
    expect(container.querySelector('[data-cloud-card-usage]')).toBeNull()
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('Wake')
  })

  it('PAIRED-CHROME: an asleep paired row (no Wake yet) says opening it wakes it', () => {
    const { container } = render(card('sleeping', { actions: { onSleep: noop } }))
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Wake'
    )
    expect(container.querySelector('[data-cloud-card-wake-hint]')?.textContent).toBe(
      'Opens and wakes when you select it.'
    )
  })

  it('an asleep owned row offers Wake, no hint', () => {
    const { container } = render(card('sleeping'))
    expect(container.querySelector('[data-cloud-card-wake-hint]')).toBeNull()
  })

  it('the usage line discloses Details, remembered for the session', () => {
    const { container, unmount } = render(card('running'))
    expect(container.querySelector('[data-cloud-card-details]')).toBeNull()
    fireEvent.click(container.querySelector('[data-cloud-card-usage]')!)
    expect(container.querySelector('[data-cloud-card-details]')).not.toBeNull()
    unmount()
    const again = render(card('running'))
    expect(again.container.querySelector('[data-cloud-card-details]')).not.toBeNull()
  })

  it('shows the attention row only when something needs doing', () => {
    const { container } = render(
      card('running', { attention: { kind: 'secretsMissing', count: 2 } })
    )
    expect(container.querySelector('[data-cloud-card-attention]')?.textContent).toBe(
      '2 secrets missing'
    )
  })

  it('Esc leaves the On this computer sub-panel before closing the card', () => {
    const escape: { current: (() => boolean) | null } = { current: null }
    const { container } = render(card('running', { escapeRef: escape }))
    expect(escape.current?.()).toBe(false)
    fireEvent.click(container.querySelector('[data-cloud-card-on-computer]')!)
    expect(container.textContent).not.toContain('Sleep')
    let handled = false
    act(() => {
      handled = escape.current?.() ?? false
    })
    expect(handled).toBe(true)
    expect(container.textContent).toContain('Sleep')
  })
})

describe('card placement', () => {
  it('opens beside the sidebar, not over the row it describes', () => {
    const sidebar = document.createElement('div')
    sidebar.setAttribute('data-left-sidebar', '')
    const mark = document.createElement('button')
    sidebar.append(mark)
    document.body.append(sidebar)
    const rect = (right: number): DOMRect => new DOMRect(0, 0, right, 10)
    sidebar.getBoundingClientRect = () => rect(260)
    mark.getBoundingClientRect = () => rect(40)
    expect(cloudCardSideOffset(mark)).toBe(228)
    sidebar.remove()
    // Outside the sidebar (fixtures, other hosts): just right of the mark.
    expect(cloudCardSideOffset(document.createElement('button'))).toBe(10)
    expect(cloudCardSideOffset(null)).toBe(10)
  })
})
