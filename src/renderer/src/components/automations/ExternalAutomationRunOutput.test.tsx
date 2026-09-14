// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import {
  clearExternalRunOutputCache,
  ExternalAutomationRunOutput
} from './ExternalAutomationRunOutput'
import { makeExternalManager, makeExternalAutomationScope } from './automations-page-fixtures'
import type { SelectedExternalRunPage } from './automation-page-state'

vi.mock('./HermesCronOutputView', () => ({
  HermesCronOutputView: ({ content }: { content: string }) => <pre>{content}</pre>
}))
const request = vi.fn()
let root: Root
let container: HTMLDivElement
function selection(id: string): SelectedExternalRunPage {
  const manager = makeExternalManager()
  return {
    manager,
    job: manager.jobs[0],
    scope: makeExternalAutomationScope(),
    run: {
      id,
      managerId: manager.id,
      jobId: 'job-1',
      provider: 'hermes',
      runAt: null,
      status: 'completed',
      outputPreview: 'preview',
      outputContent: null,
      outputContentDeferred: true,
      outputPath: null,
      error: null
    }
  }
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  request.mockReset()
  clearExternalRunOutputCache()
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { automations: { listExternalRunsForOwner: request } }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('drops late responses after selecting a different run and carries the captured owner', async () => {
  let finishOld!: (page: unknown) => void
  let finishNew!: (page: unknown) => void
  request
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve
        })
    )
  vi.useFakeTimers()
  const old = selection('old')
  const next = selection('next')
  next.scope = makeExternalAutomationScope({
    owner: {
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: 'box', targetGeneration: 3 }
    }
  })
  await act(async () => root.render(<ExternalAutomationRunOutput selected={old} />))
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading run output')
  await act(async () => root.render(<ExternalAutomationRunOutput selected={next} />))
  expect(request).toHaveBeenLastCalledWith(
    expect.objectContaining({ owner: next.scope.owner, runId: 'next', jobId: 'job-1' })
  )
  await act(async () =>
    finishNew({
      runs: [{ ...next.run, outputContentDeferred: undefined, outputContent: 'new log' }]
    })
  )
  await act(async () =>
    finishOld({
      runs: [{ ...old.run, outputContentDeferred: undefined, outputContent: 'old log' }]
    })
  )
  expect(container.textContent).toBe('new log')
})

it('renders old-host full content without a detail fetch', async () => {
  const selected = selection('legacy')
  delete selected.run.outputContentDeferred
  selected.run.outputContent = 'legacy log'
  await act(async () => root.render(<ExternalAutomationRunOutput selected={selected} />))
  expect(container.textContent).toBe('legacy log')
  expect(request).not.toHaveBeenCalled()
})

it('shows a persistent error with retry when the selected output disappeared', async () => {
  request.mockResolvedValueOnce({ runs: [] }).mockResolvedValueOnce({
    runs: [
      { ...selection('run').run, outputContentDeferred: undefined, outputContent: 'restored log' }
    ]
  })
  await act(async () => root.render(<ExternalAutomationRunOutput selected={selection('run')} />))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('unavailable')
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toBe('restored log')
})

it('keeps the row summary visible before the spinner and beside the error', async () => {
  let finish!: (page: unknown) => void
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  vi.useFakeTimers()
  const selected = selection('run')
  selected.run.error = 'row error'
  await act(async () => root.render(<ExternalAutomationRunOutput selected={selected} />))
  expect(container.textContent).toBe('row error')
  expect(container.querySelector('[role="status"]')).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(250))
  expect(container.querySelector('[role="status"]')).not.toBeNull()
  expect(container.querySelector('pre')?.textContent).toBe('row error')
  await act(async () => finish({ runs: [] }))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('unavailable')
  expect(container.querySelector('pre')?.textContent).toBe('row error')
})

it('reuses a loaded log when the same run is reopened', async () => {
  request.mockResolvedValue({
    runs: [{ ...selection('run').run, outputContentDeferred: undefined, outputContent: 'log' }]
  })
  await act(async () => root.render(<ExternalAutomationRunOutput selected={selection('run')} />))
  expect(container.textContent).toBe('log')
  await act(async () => root.render(<ExternalAutomationRunOutput selected={selection('other')} />))
  await act(async () => root.render(<ExternalAutomationRunOutput selected={selection('run')} />))
  expect(container.textContent).toBe('log')
  expect(request.mock.calls.map(([params]) => params.runId)).toEqual(['run', 'other'])
})

it('localizes the unavailable message', async () => {
  i18n.addResourceBundle('en', 'translation', {
    automations: { runOutput: { unavailable: 'LOCALIZED unavailable' } }
  })
  try {
    request.mockResolvedValueOnce({ runs: [] })
    await act(async () => root.render(<ExternalAutomationRunOutput selected={selection('run')} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('LOCALIZED unavailable')
  } finally {
    i18n.removeResourceBundle('en', 'translation')
  }
})
