// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { resetAgentStatusEpochClockForTests } from '@/lib/agent-status-epoch-clock'

type StoreState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  agentStatusEpoch: number
  retainedAgentsByPaneKey: Record<string, { entry: AgentStatusEntry }>
  acknowledgedAgentsByPaneKey: Record<string, number>
  petSize: number
}

const storeState = vi.hoisted((): StoreState => ({
  agentStatusByPaneKey: {},
  agentStatusEpoch: 0,
  retainedAgentsByPaneKey: {},
  acknowledgedAgentsByPaneKey: {},
  petSize: 180
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(<T,>(selector: (state: StoreState) => T): T => selector(storeState), {
    getState: () => storeState
  })
}))

// Why: 20px frames in a 180px overlay scale by 9, so the idle row (0) sits at
// y=0 and the review row (3) at y=-540px.
vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({
    url: 'blob:custom-pet',
    ready: true,
    sprite: {
      frameWidth: 20,
      frameHeight: 20,
      columns: 4,
      rows: 4,
      sheetWidth: 80,
      sheetHeight: 80,
      fps: 8,
      defaultAnimation: 'idle',
      animations: {
        idle: { row: 0, frames: 4 },
        review: { row: 3, frames: 4 }
      }
    },
    detected: null
  })
}))

import { PetOverlay } from './PetOverlay'

const IDLE_POSITION = '0px 0px'
const REVIEW_POSITION = '0px -540px'

function installLocalStorage(): void {
  const values = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    }
  })
}

function doneEntry(paneKey: string, stateStartedAt: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: stateStartedAt,
    stateStartedAt,
    paneKey,
    stateHistory: []
  }
}

function spritePosition(container: HTMLElement): string | undefined {
  return Array.from(container.querySelectorAll('div')).find(
    (div) => div.style.backgroundImage !== ''
  )?.style.backgroundPosition
}

describe('PetOverlay acknowledgement', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  function render(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<PetOverlay />))
    return container
  }

  beforeEach(() => {
    installLocalStorage()
    resetAgentStatusEpochClockForTests()
    storeState.agentStatusByPaneKey = {}
    storeState.retainedAgentsByPaneKey = {}
    storeState.acknowledgedAgentsByPaneKey = {}
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('plays review for a finished agent that has not been seen', () => {
    const startedAt = Date.now() - 1_000
    storeState.agentStatusByPaneKey = { 'tab:P': doneEntry('tab:P', startedAt) }

    expect(spritePosition(render())).toBe(REVIEW_POSITION)
  })

  it('reads the store acknowledgement and returns to idle for a seen done agent', () => {
    const startedAt = Date.now() - 1_000
    storeState.agentStatusByPaneKey = { 'tab:P': doneEntry('tab:P', startedAt) }
    storeState.acknowledgedAgentsByPaneKey = { 'tab:P': startedAt }

    expect(spritePosition(render())).toBe(IDLE_POSITION)
  })

  it('reads the store acknowledgement and returns to idle for a seen retained agent', () => {
    const startedAt = Date.now() - 1_000
    storeState.retainedAgentsByPaneKey = { 'tab:P': { entry: doneEntry('tab:P', startedAt) } }
    storeState.acknowledgedAgentsByPaneKey = { 'tab:P': startedAt + 1 }

    expect(spritePosition(render())).toBe(IDLE_POSITION)
  })
})
