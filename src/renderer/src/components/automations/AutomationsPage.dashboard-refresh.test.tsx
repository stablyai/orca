// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent, within } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationRunsPage } from '../../../../shared/automations-types'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, makeRun } from './automations-page-fixtures'

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

installAutomationsPageHarness()

describe('AutomationsPage dashboard refresh isolation', () => {
  it('preserves pages and unrelated hosts on events, with an independent manual refresh', async () => {
    const user = userEvent.setup()
    runtimeHost(
      [makeAutomation({ id: 'remote', name: 'Remote nightly' })],
      [makeRun({ automationId: 'remote', title: 'Remote run' })]
    )
    const pages = new Map<string, AutomationRunsPage>([
      [
        'head',
        {
          runs: [makeRun({ id: 'newest', title: 'Newest run', scheduledFor: 3 })],
          nextCursor: 'older'
        }
      ],
      [
        'older',
        {
          runs: [makeRun({ id: 'older', title: 'Older run', scheduledFor: 2 })],
          nextCursor: 'oldest'
        }
      ],
      [
        'oldest',
        {
          runs: [makeRun({ id: 'oldest', title: 'Oldest run', scheduledFor: 1 })],
          nextCursor: null
        }
      ]
    ])
    const dashboardRead = vi.fn((cursor?: string) => pages.get(cursor ?? 'head'))
    const previous = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(async (target, method, params, options) => {
      return target.kind !== 'environment' && method === 'automation.runs' && params.limit
        ? dashboardRead(params.cursor)
        : await previous?.(target, method, params, options)
    })
    const remoteReads = (): number =>
      mocks.callRuntimeRpc.mock.calls.filter(
        ([target, method]) => target.kind === 'environment' && method === 'automation.runs'
      ).length
    const { container } = await renderPage()
    const page = within(container)
    await settleHostQueries()
    await act(async () => user.click(page.getByRole('button', { name: 'Runs' })))
    await settleHostQueries()
    expect(page.getByText('Remote run')).toBeTruthy()
    const scrollArea = page.getByText('Newest run').closest('.scrollbar-sleek')
    if (!scrollArea) {
      throw new Error('Runs scroll area missing')
    }
    await act(async () => fireEvent.scroll(scrollArea))
    await settleHostQueries()
    expect(page.getByText('Older run')).toBeTruthy()
    const dashboardReadsBefore = dashboardRead.mock.calls.length
    const remoteReadsBefore = remoteReads()

    await act(async () =>
      emitAutomationsChangedWindowEvent({ selector: { kind: 'self' }, reason: 'usage' })
    )
    await settleHostQueries()

    expect(page.getByText('Older run')).toBeTruthy()
    expect(dashboardRead).toHaveBeenCalledTimes(dashboardReadsBefore)
    expect(remoteReads()).toBe(remoteReadsBefore)
    await act(async () => fireEvent.scroll(scrollArea))
    await settleHostQueries()
    expect(page.getByText('Oldest run')).toBeTruthy()
    expect(dashboardRead).toHaveBeenLastCalledWith('oldest')
    const selectedReadsBefore = api.automations.listRuns.mock.calls.length
    pages.set('head', { runs: [makeRun({ title: 'Updated run' })], nextCursor: null })

    await act(async () => user.click(page.getByRole('button', { name: 'Refresh runs' })))
    await settleHostQueries()

    expect(page.getByText('Updated run')).toBeTruthy()
    expect(page.queryByText('Older run')).toBeNull()
    expect(remoteReads()).toBe(remoteReadsBefore + 1)
    expect(api.automations.listRuns).toHaveBeenCalledTimes(selectedReadsBefore)
  })
})
