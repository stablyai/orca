// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pluginPanelDrawStatus } from './plugin-panel-draw-status'
import { useReportDeclarativePanelDraw } from './use-plugin-panel-draw-report'

const TAB = 'plugin:acme.todos/todos'

function Probe(props: {
  guestUrl: string
  rendered: string | null
  issue: { message: string } | null
}): null {
  useReportDeclarativePanelDraw(TAB, props.guestUrl, props.rendered, props.issue)
  return null
}

let root: Root
let render: (props: Parameters<typeof Probe>[0]) => void

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  root = createRoot(document.createElement('div'))
  render = (props) => act(() => root.render(createElement(Probe, props)))
})

afterEach(() => act(() => root.unmount()))

describe('useReportDeclarativePanelDraw', () => {
  it('counts only a tree from the current guest as drawn', () => {
    render({ guestUrl: 'g?rev=1', rendered: null, issue: null })
    expect(pluginPanelDrawStatus(TAB)?.drawn).toBe(false)
    render({ guestUrl: 'g?rev=1', rendered: 'doc-a', issue: null })
    expect(pluginPanelDrawStatus(TAB)).toMatchObject({ guestUrl: 'g?rev=1', drawn: true })
    // A dev save: the last good tree stays on screen until the new guest renders.
    render({ guestUrl: 'g?rev=2', rendered: 'doc-a', issue: null })
    expect(pluginPanelDrawStatus(TAB)).toMatchObject({ guestUrl: 'g?rev=2', drawn: false })
    render({ guestUrl: 'g?rev=2', rendered: 'doc-b', issue: null })
    expect(pluginPanelDrawStatus(TAB)?.drawn).toBe(true)
  })

  it('counts a fresh error as drawn, but not one left from the replaced guest', () => {
    const stale = { message: 'old boom' }
    render({ guestUrl: 'g?rev=1', rendered: 'doc-a', issue: stale })
    render({ guestUrl: 'g?rev=2', rendered: 'doc-a', issue: stale })
    expect(pluginPanelDrawStatus(TAB)).toMatchObject({ drawn: false, issue: 'old boom' })
    render({ guestUrl: 'g?rev=2', rendered: 'doc-a', issue: { message: 'new boom' } })
    expect(pluginPanelDrawStatus(TAB)).toMatchObject({ drawn: true, issue: 'new boom' })
  })

  it('forgets the panel when it unmounts', () => {
    render({ guestUrl: 'g?rev=1', rendered: 'doc-a', issue: null })
    act(() => root.unmount())
    expect(pluginPanelDrawStatus(TAB)).toBeNull()
    root = createRoot(document.createElement('div'))
  })
})
