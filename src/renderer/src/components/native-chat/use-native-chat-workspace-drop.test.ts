// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import type { DragEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import {
  encodeWorkspaceFilePaths,
  WORKSPACE_FILE_PATHS_MIME,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'
import { useNativeChatWorkspaceDrop } from './use-native-chat-workspace-drop'

function dragEvent(
  paths: readonly string[],
  types = [WORKSPACE_FILE_PATHS_MIME]
): {
  event: DragEvent<HTMLDivElement>
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
  transfer: DataTransfer
} {
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  const payload = encodeWorkspaceFilePaths(paths)
  const payloadType = types.includes(WORKSPACE_FILE_PATHS_MIME)
    ? WORKSPACE_FILE_PATHS_MIME
    : WORKSPACE_FILE_PATH_MIME
  const transfer = {
    dropEffect: 'none',
    types,
    getData: (type: string) => (type === payloadType ? payload : '')
  } as unknown as DataTransfer
  return {
    event: {
      dataTransfer: transfer,
      preventDefault,
      stopPropagation
    } as unknown as DragEvent<HTMLDivElement>,
    preventDefault,
    stopPropagation,
    transfer
  }
}

function renderWorkspaceDrop(
  options: {
    disabled?: boolean
    insertTypedText?: (text: string) => boolean
    setNotice?: (notice: string | null) => void
  } = {}
): ReturnType<typeof useNativeChatWorkspaceDrop> {
  const { result } = renderHook(() =>
    useNativeChatWorkspaceDrop({
      disabled: options.disabled ?? false,
      insertTypedText: options.insertTypedText ?? (() => true),
      setNotice: options.setNotice ?? (() => {})
    })
  )
  return result.current
}

describe('useNativeChatWorkspaceDrop', () => {
  it('advertises a copy drop only for supported workspace drags', () => {
    const handlers = renderWorkspaceDrop()
    const supported = dragEvent(['/repo'])
    handlers.onDragOver(supported.event)
    expect(supported.preventDefault).toHaveBeenCalledOnce()
    expect(supported.stopPropagation).toHaveBeenCalledOnce()
    expect(supported.transfer.dropEffect).toBe('copy')

    const legacySinglePath = dragEvent(['/repo'], [WORKSPACE_FILE_PATH_MIME])
    handlers.onDragOver(legacySinglePath.event)
    expect(legacySinglePath.preventDefault).toHaveBeenCalledOnce()

    const unrelated = dragEvent(['/repo'], ['text/plain'])
    handlers.onDragOver(unrelated.event)
    expect(unrelated.preventDefault).not.toHaveBeenCalled()
    expect(unrelated.stopPropagation).not.toHaveBeenCalled()
  })

  it('preserves Windows paths, spaces, and Unicode as editable lines', () => {
    const insertTypedText = vi.fn(() => true)
    const setNotice = vi.fn()
    const handlers = renderWorkspaceDrop({ insertTypedText, setNotice })
    const dropped = dragEvent([
      'C:\\Users\\muham\\Masaüstü\\KOHORT_TABLOLARI.md',
      'C:\\Users\\muham\\Masaüstü\\Folder With Spaces'
    ])
    handlers.onDrop(dropped.event)
    expect(insertTypedText).toHaveBeenCalledWith(
      'C:\\Users\\muham\\Masaüstü\\KOHORT_TABLOLARI.md\n' +
        'C:\\Users\\muham\\Masaüstü\\Folder With Spaces'
    )
    expect(setNotice).toHaveBeenCalledWith(null)
  })

  it('leaves disabled composers and unrelated drags untouched', () => {
    const insertTypedText = vi.fn(() => true)
    const handlers = renderWorkspaceDrop({ disabled: true, insertTypedText })
    const dropped = dragEvent(['/repo'])
    handlers.onDrop(dropped.event)
    expect(dropped.preventDefault).not.toHaveBeenCalled()
    expect(insertTypedText).not.toHaveBeenCalled()
  })

  it('surfaces bounded-decoder rejection without inserting partial paths', () => {
    const insertTypedText = vi.fn(() => true)
    const setNotice = vi.fn()
    const handlers = renderWorkspaceDrop({ insertTypedText, setNotice })
    const paths = Array.from(
      { length: NATIVE_FILE_DROP_MAX_PATHS + 1 },
      (_, index) => `/repo/${index}`
    )
    handlers.onDrop(dragEvent(paths).event)
    expect(insertTypedText).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith('Drop contains too many paths.')
  })

  it('does not clear an existing notice when insertion is unavailable', () => {
    const setNotice = vi.fn()
    const handlers = renderWorkspaceDrop({ insertTypedText: () => false, setNotice })
    handlers.onDrop(dragEvent(['/repo']).event)
    expect(setNotice).not.toHaveBeenCalled()
  })
})
