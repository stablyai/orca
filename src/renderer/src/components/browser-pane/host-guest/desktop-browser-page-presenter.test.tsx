// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import type { DesktopBrowserPage } from './desktop-browser-page-registry'
import type { DesktopBrowserPagePresentation } from './desktop-browser-page-presentation'

type PresentationCallbacks = { onMode: (forwarded: boolean) => void }

const presentation = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test setup initializes the callback before any simulated interaction.
  current: null as PresentationCallbacks | null,
  isCurrent: true,
  refresh: vi.fn(),
  dispose: vi.fn()
}))

vi.mock('./desktop-browser-page-presentation', () => ({
  presentDesktopBrowserPage: (options: PresentationCallbacks) => {
    presentation.current = options
    return {
      refresh: presentation.refresh,
      isCurrent: () => presentation.isCurrent,
      dispose: presentation.dispose
    }
  }
}))

import { DesktopBrowserPagePresenter } from './desktop-browser-page-presenter'

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function state(): DesktopBrowserViewState {
  return {
    browserPageId: 'page',
    generation: 'generation',
    revision: 1,
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    zoomLevel: 0,
    focused: false
  }
}

function fixture(override: Partial<DesktopBrowserPagePresentation> = {}) {
  const content = document.createElement('div')
  const scroller = document.createElement('div')
  document.body.append(content, scroller)
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 400, 200))
  const api: DesktopBrowserViewApi = {
    create: vi.fn(async () => state()),
    close: vi.fn(async () => {}),
    command: vi.fn(async () => ({ state: state() })),
    updateLayout: vi.fn(async () => {}),
    input: vi.fn(async () => {}),
    captureViewport: vi.fn(async () => ({
      dataUrl: 'data:image/png;base64,AA==',
      width: 1,
      height: 1
    })),
    onEvent: () => () => {}
  }
  const page = {
    api,
    state: state(),
    surface: { focus: vi.fn(async () => true) },
    destroyed: false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: presenter reads only api, state, surface, and destroyed from this controlled fixture.
  const desktopPage = page as unknown as DesktopBrowserPage
  const focusRef: MutableRefObject<HTMLElement | null> = { current: null }
  const view = render(
    <DesktopBrowserPagePresenter
      page={desktopPage}
      content={content}
      scroller={scroller}
      state={{ active: true, inputLocked: false, hidden: false, ...override }}
      focusRef={focusRef}
      onDragOver={vi.fn()}
      onDrop={vi.fn()}
    />
  )
  const textarea = view.getByLabelText('Browser page')
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Browser page input was not a textarea')
  }
  return { api, content, desktopPage, focusRef, scroller, textarea, view }
}

beforeEach(() => {
  presentation.current = null
  presentation.isCurrent = true
  presentation.refresh.mockClear()
  presentation.dispose.mockClear()
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('desktop browser page presenter', () => {
  it('forwards normalized pointer input and releases capture after pointerup', async () => {
    const value = fixture()
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(value.textarea, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release
    })
    act(() => presentation.current?.onMode(true))

    fireEvent.pointerDown(value.textarea, {
      clientX: 200,
      clientY: 100,
      button: 0,
      buttons: 1,
      pointerId: 7
    })
    fireEvent.pointerUp(value.textarea, {
      clientX: 500,
      clientY: 250,
      button: 0,
      buttons: 0,
      pointerId: 7
    })
    await flush()

    expect(capture).toHaveBeenCalledWith(7)
    expect(release).toHaveBeenCalledWith(7)
    expect(value.api.input).toHaveBeenNthCalledWith(1, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'mouse', type: 'down', x: 0.25, y: 0.25 })
    })
    expect(value.api.input).toHaveBeenNthCalledWith(2, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'mouse', type: 'up', x: 1, y: 1 })
    })
  })

  it('releases a captured mouse button when occlusion disables forwarding before pointerup', async () => {
    const value = fixture()
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(value.textarea, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release
    })
    act(() => presentation.current?.onMode(true))
    fireEvent.pointerDown(value.textarea, {
      clientX: 200,
      clientY: 100,
      button: 0,
      buttons: 1,
      pointerId: 7
    })
    act(() => presentation.current?.onMode(false))
    fireEvent.pointerUp(value.textarea, {
      clientX: 200,
      clientY: 100,
      button: 0,
      buttons: 0,
      pointerId: 7
    })
    await flush()

    expect(release).toHaveBeenCalledWith(7)
    expect(value.api.input).toHaveBeenLastCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'mouse', type: 'up', buttons: 0 })
    })
  })

  it('releases DOM pointer capture when forwarding mode flushes held input', async () => {
    const value = fixture()
    const release = vi.fn()
    Object.assign(value.textarea, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: release
    })
    act(() => presentation.current?.onMode(true))
    fireEvent.pointerDown(value.textarea, {
      clientX: 200,
      clientY: 100,
      button: 0,
      buttons: 1,
      pointerId: 7
    })
    act(() => presentation.current?.onMode(false))
    await flush()

    expect(release).toHaveBeenCalledWith(7)
    expect(value.api.input).toHaveBeenLastCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'mouse', type: 'up', buttons: 0 })
    })
  })

  it('releases a captured mouse button on pointercancel', async () => {
    const value = fixture()
    const release = vi.fn()
    Object.assign(value.textarea, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: release
    })
    act(() => presentation.current?.onMode(true))
    fireEvent.pointerDown(value.textarea, {
      clientX: 200,
      clientY: 100,
      button: 0,
      buttons: 1,
      pointerId: 7
    })
    fireEvent.pointerCancel(value.textarea, { pointerId: 7 })
    await flush()

    expect(release).toHaveBeenCalledWith(7)
    expect(value.api.input).toHaveBeenLastCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'mouse', type: 'up', buttons: 0 })
    })
  })

  it('does not forward guest input while a modal lock is active', async () => {
    const value = fixture({ inputLocked: true })
    act(() => presentation.current?.onMode(true))
    fireEvent.keyDown(value.textarea, { key: 'a', code: 'KeyA' })
    fireEvent.paste(value.textarea, { clipboardData: { getData: () => 'blocked' } })
    await flush()

    expect(value.api.input).not.toHaveBeenCalled()
    expect(value.textarea.disabled).toBe(true)
  })

  it('sends text, committed composition, and paste without reusing keystroke text', async () => {
    const value = fixture()
    act(() => presentation.current?.onMode(true))

    fireEvent.keyDown(value.textarea, { key: 'a', code: 'KeyA' })
    fireEvent.compositionStart(value.textarea)
    const compositionEnd = new Event('compositionend', { bubbles: true })
    Object.defineProperty(compositionEnd, 'data', { value: '確定' })
    fireEvent(value.textarea, compositionEnd)
    fireEvent.paste(value.textarea, { clipboardData: { getData: () => 'pasted' } })
    await flush()

    expect(value.api.input).toHaveBeenCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', key: 'a', text: 'a' })
    })
    expect(value.api.input).toHaveBeenCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: { kind: 'composition', text: '確定' }
    })
    expect(value.api.input).toHaveBeenCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: { kind: 'text', text: 'pasted' }
    })
  })

  it('allows a window capture shortcut to prevent a guest key dispatch', async () => {
    const value = fixture()
    act(() => presentation.current?.onMode(true))
    const consume = (event: KeyboardEvent): void => event.preventDefault()
    window.addEventListener('keydown', consume, { capture: true })
    fireEvent.keyDown(value.textarea, { key: 'r', code: 'KeyR', ctrlKey: true })
    await flush()
    window.removeEventListener('keydown', consume, { capture: true })

    expect(value.api.input).not.toHaveBeenCalled()
  })

  it('releases Tab after preventing its browser focus navigation', async () => {
    const value = fixture()
    act(() => presentation.current?.onMode(true))

    fireEvent.keyDown(value.textarea, { key: 'Tab', code: 'Tab' })
    fireEvent.keyUp(value.textarea, { key: 'Tab', code: 'Tab' })
    fireEvent.blur(value.textarea)
    await flush()

    expect(value.api.input).toHaveBeenNthCalledWith(1, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', type: 'down', key: 'Tab', text: '\t' })
    })
    expect(value.api.input).toHaveBeenNthCalledWith(2, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', type: 'up', key: 'Tab' })
    })
    expect(value.api.input).toHaveBeenCalledTimes(2)
  })

  it('releases held keys when browser-page focus is lost', async () => {
    const value = fixture()
    act(() => presentation.current?.onMode(true))
    fireEvent.keyDown(value.textarea, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    await flush()
    fireEvent.blur(value.textarea)
    await flush()

    expect(value.api.input).toHaveBeenLastCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: {
        kind: 'key',
        type: 'up',
        key: 'Shift',
        code: 'ShiftLeft',
        modifiers: ['Shift']
      }
    })
  })

  it('releases held input through the old page before routing new input to a replacement', async () => {
    const value = fixture()
    const replacementApi: DesktopBrowserViewApi = { ...value.api, input: vi.fn(async () => {}) }
    const replacementPage = {
      ...value.desktopPage,
      api: replacementApi,
      state: { ...value.desktopPage.state, browserPageId: 'replacement', generation: 'next' }
    }
    act(() => presentation.current?.onMode(true))
    fireEvent.keyDown(value.textarea, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    await flush()

    value.view.rerender(
      <DesktopBrowserPagePresenter
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this controlled fixture preserves the DesktopBrowserPage members the presenter reads.
        page={replacementPage as DesktopBrowserPage}
        content={value.content}
        scroller={value.scroller}
        state={{ active: true, inputLocked: false, hidden: false }}
        focusRef={value.focusRef}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
      />
    )
    await flush()
    fireEvent.keyDown(value.textarea, { key: 'a', code: 'KeyA' })
    await flush()

    expect(value.api.input).toHaveBeenLastCalledWith({
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', type: 'up', code: 'ShiftLeft' })
    })
    expect(replacementApi.input).toHaveBeenLastCalledWith({
      browserPageId: 'replacement',
      generation: 'next',
      input: expect.objectContaining({ kind: 'key', type: 'down', code: 'KeyA' })
    })
  })

  it('queues held-input cleanup before new input after the same page remounts', async () => {
    const value = fixture()
    let releaseFirstInput: (() => void) | undefined
    const firstInput = new Promise<void>((resolve) => {
      releaseFirstInput = resolve
    })
    vi.mocked(value.api.input).mockImplementationOnce(() => firstInput)
    act(() => presentation.current?.onMode(true))
    fireEvent.keyDown(value.textarea, { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    await flush()
    expect(value.api.input).toHaveBeenCalledTimes(1)

    value.view.unmount()
    const remounted = render(
      <DesktopBrowserPagePresenter
        page={value.desktopPage}
        content={value.content}
        scroller={value.scroller}
        state={{ active: true, inputLocked: false, hidden: false }}
        focusRef={value.focusRef}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
      />
    )
    const textarea = remounted.getByLabelText('Browser page')
    act(() => presentation.current?.onMode(true))
    fireEvent.keyDown(textarea, { key: 'a', code: 'KeyA' })
    expect(value.api.input).toHaveBeenCalledTimes(1)

    releaseFirstInput?.()
    await flush()

    expect(value.api.input).toHaveBeenNthCalledWith(1, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', type: 'down', code: 'ShiftLeft' })
    })
    expect(value.api.input).toHaveBeenNthCalledWith(2, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', type: 'up', code: 'ShiftLeft' })
    })
    expect(value.api.input).toHaveBeenNthCalledWith(3, {
      browserPageId: 'page',
      generation: 'generation',
      input: expect.objectContaining({ kind: 'key', type: 'down', code: 'KeyA' })
    })
  })

  it('drops queued input when its presenter became stale before dispatch', async () => {
    const value = fixture()
    act(() => presentation.current?.onMode(true))
    presentation.isCurrent = false
    fireEvent.keyDown(value.textarea, { key: 'a', code: 'KeyA' })
    await flush()

    expect(value.api.input).not.toHaveBeenCalled()
  })
})
