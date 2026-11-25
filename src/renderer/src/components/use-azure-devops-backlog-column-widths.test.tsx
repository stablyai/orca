// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAzureDevOpsBacklogColumnWidths } from './use-azure-devops-backlog-column-widths'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

afterEach(() => {
  cleanup()
  toastError.mockReset()
})

const columns = [
  { referenceName: 'System.Title', name: 'Title', width: 400 },
  { referenceName: 'System.State', name: 'State', width: 100 }
]
const KEY = 'acme/P::Mobile::req'

describe('useAzureDevOpsBacklogColumnWidths', () => {
  it('applies persisted overrides over the ADO widths', () => {
    const { result } = renderHook(() =>
      useAzureDevOpsBacklogColumnWidths({
        widthKey: KEY,
        columns,
        settings: { azureDevOpsBacklogColumnWidths: { [KEY]: { 'System.State': 160 } } },
        updateSettings: vi.fn(async () => undefined)
      })
    )
    expect(result.current.columns.map((c) => c.width)).toEqual([400, 160])
    expect(result.current.hasOverrides).toBe(true)
  })

  it('streams a drag into the columns and writes settings once on drag end', async () => {
    const updateSettings = vi.fn(async () => undefined)
    const { result } = renderHook(() =>
      useAzureDevOpsBacklogColumnWidths({
        widthKey: KEY,
        columns,
        settings: { azureDevOpsBacklogColumnWidths: { other: { 'System.Title': 1 } } },
        updateSettings
      })
    )
    act(() => result.current.onResizeColumn('System.State', 120.4))
    act(() => result.current.onResizeColumn('System.State', 130))
    expect(result.current.columns[1].width).toBe(130)
    expect(updateSettings).not.toHaveBeenCalled()
    act(() => result.current.onResizeEnd())
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({
      azureDevOpsBacklogColumnWidths: {
        other: { 'System.Title': 1 },
        [KEY]: { 'System.State': 130 }
      }
    })
  })

  it('ignores drags before the scope is known', () => {
    const updateSettings = vi.fn(async () => undefined)
    const { result } = renderHook(() =>
      useAzureDevOpsBacklogColumnWidths({ widthKey: null, columns, settings: null, updateSettings })
    )
    act(() => result.current.onResizeColumn('System.State', 130))
    act(() => result.current.onResizeEnd())
    expect(result.current.columns[1].width).toBe(100)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('resets by dropping only this scope, clearing the setting when nothing is left', () => {
    const updateSettings = vi.fn(async () => undefined)
    const { result, rerender } = renderHook(
      (props: { widths: Record<string, Record<string, number>> | null }) =>
        useAzureDevOpsBacklogColumnWidths({
          widthKey: KEY,
          columns,
          settings: { azureDevOpsBacklogColumnWidths: props.widths },
          updateSettings
        }),
      {
        initialProps: {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook narrows the persisted record itself; the literal only needs the setting's declared shape.
          widths: { [KEY]: { 'System.State': 160 }, other: { X: 2 } } as Record<
            string,
            Record<string, number>
          > | null
        }
      }
    )
    act(() => result.current.resetColumnWidths())
    expect(updateSettings).toHaveBeenLastCalledWith({
      azureDevOpsBacklogColumnWidths: { other: { X: 2 } }
    })

    rerender({ widths: { [KEY]: { 'System.State': 160 } } })
    act(() => result.current.resetColumnWidths())
    expect(updateSettings).toHaveBeenLastCalledWith({ azureDevOpsBacklogColumnWidths: null })

    rerender({ widths: null })
    expect(result.current.hasOverrides).toBe(false)
    expect(result.current.columns.map((c) => c.width)).toEqual([400, 100])
  })

  it('toasts when the width write fails and keeps the dragged width on screen', async () => {
    const { result } = renderHook(() =>
      useAzureDevOpsBacklogColumnWidths({
        widthKey: KEY,
        columns,
        settings: { azureDevOpsBacklogColumnWidths: null },
        updateSettings: vi.fn(async () => {
          throw new Error('strict schema')
        })
      })
    )
    act(() => result.current.onResizeColumn('System.Title', 500))
    act(() => result.current.onResizeEnd())
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toContain('strict schema')
    expect(result.current.columns[0].width).toBe(500)
  })
})
