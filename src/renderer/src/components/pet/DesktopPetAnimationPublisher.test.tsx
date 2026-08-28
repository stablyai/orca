// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {} as Record<string, unknown>,
  agentStatusEpoch: 0,
  retainedAgentsByPaneKey: {} as Record<string, unknown>
}))

const desktopPetApi = vi.hoisted(() => ({
  publishAnimation: vi.fn(() => Promise.resolve()),
  onAnimationRequested: vi.fn((_callback: () => void) => () => {})
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
    { getState: () => storeState }
  )
}))

import { DesktopPetAnimationPublisher } from './DesktopPetAnimationPublisher'

function render(): Root {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<DesktopPetAnimationPublisher />)
  })
  return root
}

describe('DesktopPetAnimationPublisher', () => {
  beforeEach(() => {
    Object.assign(window, { api: { desktopPet: desktopPetApi } })
    storeState.agentStatusByPaneKey = {}
    storeState.retainedAgentsByPaneKey = {}
  })

  afterEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('publishes the agent-derived animation, without the pointer states the pet window owns', () => {
    storeState.agentStatusByPaneKey = {
      'tab-1:leaf-1': { state: 'working', workingMode: 'active', updatedAt: Date.now() }
    }
    const root = render()
    expect(desktopPetApi.publishAnimation).toHaveBeenCalledWith('running')
    act(() => root.unmount())
  })

  it('republishes on request even when the animation has not changed', () => {
    let requestReplay = (): void => {}
    desktopPetApi.onAnimationRequested.mockImplementation((callback) => {
      requestReplay = callback
      return () => {}
    })
    const root = render()
    expect(desktopPetApi.publishAnimation).toHaveBeenCalledTimes(1)

    act(() => requestReplay())
    expect(desktopPetApi.publishAnimation).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })
})
