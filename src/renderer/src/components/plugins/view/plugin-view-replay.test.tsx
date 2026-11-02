// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { usePluginShotReplayStore } from '@/store/plugin-shot-replay'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import { PluginShotReplayMount } from './PluginShotReplayMount'
import { handlePluginViewRequest } from './plugin-view-request-handler'

const initialState = useAppStore.getState()
const parsed = parsePluginDeclarativeTree({
  type: 'Stack',
  props: {},
  children: [{ type: 'Text', props: {}, children: ['3 counted'] }]
})
const TREE = parsed.ok ? parsed.tree : null

// Why: the handler's store updates land outside act while it waits for the preview to paint.
let previousActEnvironment: boolean | undefined
beforeAll(() => {
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
})
afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

beforeEach(() => {
  // happy-dom lays nothing out: give the preview the box its inline width asks for.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-plugin-shot-replay')
      ? DOMRect.fromRect({ x: 0, y: 0, width: Number.parseFloat(this.style.width), height: 80 })
      : DOMRect.fromRect()
  })
  useAppStore.setState({
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarWidth: 300,
    activityBarPosition: 'top'
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
  usePluginShotReplayStore.getState().clear()
  usePluginViewCaptureStore.getState().end()
})

function mount() {
  render(
    <TooltipProvider>
      <PluginShotReplayMount />
    </TooltipProvider>
  )
}

const preview = () => document.querySelector('[data-plugin-shot-replay]')

describe('replay-panel', () => {
  it('draws the tree in the preview at --width and reports its rect', async () => {
    mount()
    const reply = await handlePluginViewRequest({
      requestId: 'r1',
      kind: 'replay-panel',
      replay: { tree: TREE, width: 360, timeoutMs: 2_000 }
    })
    expect(reply).toEqual({
      requestId: 'r1',
      ok: true,
      panel: {
        rect: { x: 0, y: 0, width: 360, height: 80 },
        ui: 'components',
        guestUrl: null,
        issue: null,
        colorScheme: 'light',
        themeApplied: false,
        settled: true
      }
    })
    expect(preview()?.textContent).toContain('3 counted')
    expect(preview()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('defaults to the right sidebar width and leaves the sidebar alone', async () => {
    mount()
    const reply = await handlePluginViewRequest({
      requestId: 'r1',
      kind: 'replay-panel',
      replay: { tree: TREE, colorScheme: 'dark', timeoutMs: 2_000 }
    })
    expect(reply).toMatchObject({ ok: true, panel: { rect: { width: 300 } } })
    expect(usePluginViewCaptureStore.getState()).toMatchObject({ dark: true, panelWidth: null })
    expect(useAppStore.getState()).toMatchObject({
      rightSidebarOpen: false,
      rightSidebarTab: 'explorer'
    })
  })

  it('unmounts the preview and puts the theme back on end-capture', async () => {
    mount()
    await handlePluginViewRequest({
      requestId: 'r1',
      kind: 'replay-panel',
      replay: { tree: TREE, colorScheme: 'dark', timeoutMs: 2_000 }
    })
    expect(preview()).not.toBeNull()
    await handlePluginViewRequest({ requestId: 'r2', kind: 'end-capture' })
    await waitFor(() => expect(preview()).toBeNull())
    expect(usePluginShotReplayStore.getState().preview).toBeNull()
    expect(usePluginViewCaptureStore.getState()).toMatchObject({ dark: null, capturing: false })
  })

  it('refuses a tree the validator rejects, drawing nothing', async () => {
    mount()
    const reply = await handlePluginViewRequest({
      requestId: 'r1',
      kind: 'replay-panel',
      replay: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately invalid, to test the renderer's own check.
        tree: { type: 'Text', props: {}, children: [{ nope: 1 }] } as never,
        timeoutMs: 50
      }
    })
    expect(reply).toMatchObject({ ok: false, code: 'invalid_tree' })
    expect(preview()).toBeNull()
  })
})
