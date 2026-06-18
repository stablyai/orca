// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleAppMenuPasteRequest } from '@/lib/app-menu-paste'
import { useAppMenuPaste } from './useAppMenuPaste'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/app-menu-paste', () => ({
  handleAppMenuPasteRequest: vi.fn()
}))

type AppMenuPasteCallback = () => void
type EditableContextPasteCallback = (data: { plainTextOnly: boolean }) => void

let root: Root | null = null
let container: HTMLDivElement | null = null
let appMenuPasteCallback: AppMenuPasteCallback | null = null
let editableContextPasteCallback: EditableContextPasteCallback | null = null

const handleAppMenuPasteRequestMock = vi.mocked(handleAppMenuPasteRequest)

function Probe(): null {
  useAppMenuPaste()
  return null
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function renderProbe(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe />)
  })
}

function installApi(): { performNativePaste: ReturnType<typeof vi.fn> } {
  const performNativePaste = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onAppMenuPaste: vi.fn((callback: AppMenuPasteCallback) => {
          appMenuPasteCallback = callback
          return vi.fn()
        }),
        onEditableContextPaste: vi.fn((callback: EditableContextPasteCallback) => {
          editableContextPasteCallback = callback
          return vi.fn()
        }),
        performNativePaste,
        readClipboardText: vi.fn()
      }
    }
  })
  return { performNativePaste }
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  appMenuPasteCallback = null
  editableContextPasteCallback = null
  Reflect.deleteProperty(window, 'api')
  vi.clearAllMocks()
})

describe('useAppMenuPaste', () => {
  it('does not perform native paste from the hook when the owned request rejects', async () => {
    const { performNativePaste } = installApi()
    handleAppMenuPasteRequestMock.mockRejectedValueOnce(new Error('unexpected paste failure'))

    await renderProbe()

    expect(appMenuPasteCallback).not.toBeNull()
    expect(editableContextPasteCallback).not.toBeNull()

    await act(async () => {
      appMenuPasteCallback?.()
      await flushPromises()
    })

    expect(handleAppMenuPasteRequestMock).toHaveBeenCalledTimes(1)
    expect(performNativePaste).not.toHaveBeenCalled()
  })
})
