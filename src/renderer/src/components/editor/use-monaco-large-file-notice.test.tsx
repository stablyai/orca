// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))

import { useMonacoLargeFileNotice } from './use-monaco-large-file-notice'

function editorReporting(tooLarge: unknown): editor.IStandaloneCodeEditor {
  return {
    getModel: () => (tooLarge === undefined ? {} : { isTooLargeForTokenization: () => tooLarge })
  } as unknown as editor.IStandaloneCodeEditor
}

describe('useMonacoLargeFileNotice', () => {
  beforeEach(() => {
    toastMock.mockClear()
  })

  it('explains the degradation the model reports, once per file', () => {
    const { rerender } = renderHook(
      ({ path }: { path: string }) => useMonacoLargeFileNotice(editorReporting(true), path),
      { initialProps: { path: '/repo/generated.json' } }
    )
    rerender({ path: '/repo/generated.json' })

    expect(toastMock).toHaveBeenCalledTimes(1)
    expect(toastMock.mock.calls[0][0]).toContain('Large file')
  })

  it('stays silent when the model reports no degradation', () => {
    renderHook(() => useMonacoLargeFileNotice(editorReporting(false), '/repo/small.json'))
    expect(toastMock).not.toHaveBeenCalled()
  })

  // Claiming features are off because we could not read the flag would be a
  // guess presented as an observation.
  it('stays silent when the degradation flag cannot be read', () => {
    renderHook(() => useMonacoLargeFileNotice(editorReporting(undefined), '/repo/unknown.json'))
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('stays silent before the editor mounts', () => {
    renderHook(() => useMonacoLargeFileNotice(null, '/repo/generated.json'))
    expect(toastMock).not.toHaveBeenCalled()
  })
})
