// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { DictationSetupPill } from './DictationSetupPill'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const cancelDownload = vi.fn(async () => {})
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  cancelDownload.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      speech: {
        // Neither the download nor its first progress arrives before the pill is closed.
        downloadModel: () => new Promise(() => {}),
        cancelDownload,
        getModelStates: () => new Promise(() => {}),
        onDownloadProgress: () => () => {}
      }
    }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    modelStates: [{ id: 'parakeet', status: 'not-downloaded', needsUpdate: true }]
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

it('cancels a download started from the pill when it is closed before any progress', async () => {
  const onClose = vi.fn()
  await act(async () => {
    root.render(
      <TooltipProvider>
        <DictationSetupPill
          target={{
            model: {
              id: 'parakeet',
              label: 'Parakeet',
              type: 'transducer',
              provider: 'local',
              language: 'en',
              languages: ['en'],
              sampleRate: 16000,
              streaming: false
            }
          }}
          anchor={null}
          onClose={onClose}
        />
      </TooltipProvider>
    )
  })

  await act(async () => button('Install').click())
  await act(async () => button('Cancel download').click())

  expect(cancelDownload).toHaveBeenCalledWith('parakeet')
  expect(onClose).toHaveBeenCalledOnce()
})
