// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MetricPair } from './process-resource-metric-columns'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
})

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(element)
  })
  return container
}

describe('MetricPair', () => {
  it('renders at normal contrast when cpu and memory are both unavailable but uptime has a value', () => {
    const el = render(<MetricPair cpu={null} memory={null} uptimeSeconds={120} showUptime />)

    const wrapper = el.firstElementChild as HTMLElement
    expect(wrapper.className).not.toContain('text-muted-foreground/50')
    expect(wrapper.className).toContain('text-muted-foreground')
  })

  it('stays muted when cpu, memory, and uptime are all unavailable', () => {
    const el = render(<MetricPair cpu={null} memory={null} uptimeSeconds={null} showUptime />)

    const wrapper = el.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('text-muted-foreground/50')
  })

  it('stays muted when uptime is not shown, regardless of its value', () => {
    const el = render(<MetricPair cpu={null} memory={null} uptimeSeconds={999} />)

    const wrapper = el.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('text-muted-foreground/50')
  })
})
