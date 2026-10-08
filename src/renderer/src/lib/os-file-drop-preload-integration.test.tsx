// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../shared/native-file-drop-preparation'

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  getPathForFile: vi.fn((file: File) => `/dropped/${file.name}`)
}))

vi.mock('electron', () => ({
  ipcRenderer: electron,
  webUtils: { getPathForFile: electron.getPathForFile }
}))

import { installNativeFileDropHandlers } from '../../../preload/preload-runtime-support'
import { createOsFileDropSequence, useOsFileDropOwner } from '../hooks/use-os-file-drop-owner'
import { installOsFileDropCancellationGuard } from './os-file-drop-cancellation-guard'

const prepareDroppedPaths = vi.fn(
  async ({ paths }: { paths: string[] }): Promise<PreparedDroppedPaths> => ({ paths, failures: [] })
)

function OwnerProbe({
  onDrop,
  legacyChild = false
}: {
  onDrop: (prepared: PreparedDroppedPaths) => void
  legacyChild?: boolean
}): React.JSX.Element {
  const ownerElementRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const attach = useOsFileDropOwner(ownerElementRef, {
    consumer: 'agent',
    sequence,
    onDrop: (prepared) => onDrop(prepared)
  })
  return (
    <div ref={attach}>
      <span
        data-testid="target"
        data-native-file-drop-target={legacyChild ? 'composer' : undefined}
      />
    </div>
  )
}

function drag(
  target: Element,
  type: 'dragover' | 'drop'
): {
  event: Event
  transfer: { dropEffect: string }
} {
  const transfer = {
    types: ['Files'],
    files: [new File(['a'], 'a.txt')],
    dropEffect: 'move'
  }
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return { event, transfer }
}

let disposeGuard: (() => void) | null = null

beforeAll(() => {
  installNativeFileDropHandlers()
})

beforeEach(() => {
  vi.stubGlobal('api', { fs: { getPathForFile: electron.getPathForFile, prepareDroppedPaths } })
  electron.send.mockClear()
  electron.getPathForFile.mockClear()
  prepareDroppedPaths.mockClear()
  disposeGuard = installOsFileDropCancellationGuard()
})

afterEach(() => {
  cleanup()
  disposeGuard?.()
  disposeGuard = null
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('preload and renderer file drop guard', () => {
  it('preserves preload copy acceptance and one IPC delivery on unmarked chrome', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const hover = drag(target, 'dragover')
    expect(hover.event.defaultPrevented).toBe(true)
    expect(hover.transfer.dropEffect).toBe('copy')

    drag(target, 'drop')
    expect(electron.send).toHaveBeenCalledOnce()
    expect(electron.send.mock.calls[0][0]).toBe('terminal:file-dropped-from-preload')
    expect(prepareDroppedPaths).not.toHaveBeenCalled()
  })

  it('lets a migrated owner claim the real event and keep the copy cursor', async () => {
    const onDrop = vi.fn()
    const view = render(<OwnerProbe onDrop={onDrop} />)
    const target = view.getByTestId('target')
    const hover = drag(target, 'dragover')
    expect(hover.transfer.dropEffect).toBe('copy')
    drag(target, 'drop')
    await act(async () => undefined)
    expect(electron.send).not.toHaveBeenCalled()
    expect(prepareDroppedPaths).toHaveBeenCalledExactlyOnceWith({
      paths: ['/dropped/a.txt'],
      consumer: 'agent'
    })
    expect(onDrop).toHaveBeenCalledExactlyOnceWith({
      paths: ['/dropped/a.txt'],
      failures: []
    })
  })

  it('keeps a legacy child as a barrier inside a migrated owner', () => {
    const onDrop = vi.fn()
    const view = render(<OwnerProbe onDrop={onDrop} legacyChild />)
    const target = view.getByTestId('target')
    const hover = drag(target, 'dragover')
    expect(hover.transfer.dropEffect).toBe('copy')
    drag(target, 'drop')
    expect(electron.send).toHaveBeenCalledOnce()
    expect(prepareDroppedPaths).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
  })
})
