import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRecorderElementSummary } from './browser-recorder-types'

// Why: the repo's hook tests mock React's dispatcher directly (see
// useGrabMode.test.ts). This harness additionally supports functional
// setState updaters, which useBrowserRecorder relies on for capping.
function createReactHookHarness() {
  const refs: { current: unknown }[] = []
  // Why: a Map (not an array with ??=) so a state slot set to null/undefined
  // is never mistaken for uninitialized and silently reset on the next render.
  const states = new Map<number, unknown>()
  let refIndex = 0
  let stateIndex = 0

  return {
    beginRender: () => {
      refIndex = 0
      stateIndex = 0
    },
    react: {
      useCallback: <T extends (...args: never[]) => unknown>(callback: T): T => callback,
      useRef: <T>(initialValue: T): { current: T } => {
        const index = refIndex
        refIndex += 1
        refs[index] ??= { current: initialValue }
        return refs[index] as { current: T }
      },
      useState: <T>(initialValue: T): [T, (value: T | ((previous: T) => T)) => void] => {
        const index = stateIndex
        stateIndex += 1
        if (!states.has(index)) {
          states.set(index, initialValue)
        }
        return [
          states.get(index) as T,
          (value: T | ((previous: T) => T)) => {
            states.set(
              index,
              typeof value === 'function'
                ? (value as (previous: T) => T)(states.get(index) as T)
                : value
            )
          }
        ]
      }
    }
  }
}

describe('useBrowserRecorder', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.resetModules()
  })

  async function loadRecorder() {
    const { useBrowserRecorder } = await import('./useBrowserRecorder')
    return useBrowserRecorder
  }

  it('ignores recordStep while recording is off', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const useBrowserRecorder = await loadRecorder()

    harness.beginRender()
    const recorder = useBrowserRecorder('page-1')
    expect(recorder.recording).toBe(false)
    expect(recorder.steps).toEqual([])

    recorder.recordStep(
      { kind: 'element-selected', element: makeElement() },
      { pageUrl: 'https://example.com/a', pageTitle: 'A' }
    )
    harness.beginRender()
    const next = useBrowserRecorder('page-1')
    expect(next.steps).toEqual([])
  })

  it('starts a session with a recording-started marker and appends steps', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const useBrowserRecorder = await loadRecorder()

    harness.beginRender()
    const recorder = useBrowserRecorder('page-1')
    recorder.toggle({ pageUrl: 'https://example.com/start', pageTitle: 'Start' })

    harness.beginRender()
    const started = useBrowserRecorder('page-1')
    expect(started.recording).toBe(true)
    expect(started.startedAt).not.toBeNull()
    expect(started.steps).toHaveLength(1)
    expect(started.steps[0]?.detail.kind).toBe('recording-started')
    expect(started.steps[0]?.pageUrl).toBe('https://example.com/start')

    started.recordStep(
      { kind: 'element-selected', element: makeElement() },
      { pageUrl: 'https://example.com/a', pageTitle: 'A' }
    )
    harness.beginRender()
    const afterSelection = useBrowserRecorder('page-1')
    expect(afterSelection.steps).toHaveLength(2)
    expect(afterSelection.steps[1]?.detail.kind).toBe('element-selected')
    expect(afterSelection.steps[1]?.browserPageId).toBe('page-1')
  })

  it('stops recording on toggle-off but keeps the collected steps', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const useBrowserRecorder = await loadRecorder()

    harness.beginRender()
    const recorder = useBrowserRecorder('page-1')
    recorder.toggle()
    harness.beginRender()
    const running = useBrowserRecorder('page-1')
    running.recordStep(
      { kind: 'navigation', fromUrl: 'https://example.com/a', toUrl: 'https://example.com/b' },
      { pageUrl: 'https://example.com/b', pageTitle: 'B' }
    )
    harness.beginRender()
    const withStep = useBrowserRecorder('page-1')
    withStep.toggle()

    harness.beginRender()
    const stopped = useBrowserRecorder('page-1')
    expect(stopped.recording).toBe(false)
    expect(stopped.startedAt).toBeNull()
    expect(stopped.steps).toHaveLength(2) // start marker + navigation

    stopped.recordStep(
      { kind: 'element-selected', element: makeElement() },
      { pageUrl: 'https://example.com/c', pageTitle: 'C' }
    )
    harness.beginRender()
    const afterStop = useBrowserRecorder('page-1')
    expect(afterStop.steps).toHaveLength(2)
  })

  it('caps steps at the session budget, dropping the oldest', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const { RECORDER_BUDGET } = await import('./browser-recorder-types')
    const useBrowserRecorder = await loadRecorder()

    harness.beginRender()
    const recorder = useBrowserRecorder('page-1')
    recorder.toggle({ pageUrl: 'https://example.com/', pageTitle: 'Home' })

    for (let index = 0; index < RECORDER_BUDGET.maxStepsPerSession + 5; index += 1) {
      harness.beginRender()
      const running = useBrowserRecorder('page-1')
      running.recordStep(
        { kind: 'element-selected', element: makeElement(`#el-${index}`) },
        { pageUrl: `https://example.com/${index}`, pageTitle: `Page ${index}` }
      )
    }

    harness.beginRender()
    const capped = useBrowserRecorder('page-1')
    expect(capped.steps).toHaveLength(RECORDER_BUDGET.maxStepsPerSession)
    // Oldest (start marker + first selections) dropped; latest kept.
    const last = capped.steps.at(-1)
    expect(last?.pageUrl).toBe(`https://example.com/${RECORDER_BUDGET.maxStepsPerSession + 4}`)
    expect(capped.steps[0]?.detail.kind).toBe('element-selected')
  })

  it('clears steps and resets the session baseline while still recording', async () => {
    const harness = createReactHookHarness()
    vi.doMock('react', () => harness.react)
    const useBrowserRecorder = await loadRecorder()

    harness.beginRender()
    const recorder = useBrowserRecorder('page-1')
    recorder.toggle()
    harness.beginRender()
    const running = useBrowserRecorder('page-1')
    running.recordStep(
      { kind: 'element-selected', element: makeElement() },
      { pageUrl: 'https://example.com/a', pageTitle: 'A' }
    )
    harness.beginRender()
    const withStep = useBrowserRecorder('page-1')
    withStep.clear()

    harness.beginRender()
    const cleared = useBrowserRecorder('page-1')
    expect(cleared.steps).toEqual([])
    expect(cleared.recording).toBe(true)
    expect(cleared.startedAt).not.toBeNull()
  })
})

function makeElement(selector = '#submit'): BrowserRecorderElementSummary {
  return {
    tagName: 'button',
    selector,
    textSnippet: 'Submit form',
    accessibleName: 'Submit',
    rectViewport: { x: 10, y: 20, width: 100, height: 30 }
  }
}
