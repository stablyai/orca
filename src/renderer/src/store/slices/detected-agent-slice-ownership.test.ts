import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import { createDetectedAgentsSlice } from './detected-agents'
import { createRuntimeDetectedAgentsSlice } from './runtime-detected-agents'

function sliceKeys(creator: typeof createDetectedAgentsSlice): string[]
function sliceKeys(creator: typeof createRuntimeDetectedAgentsSlice): string[]
function sliceKeys(
  creator: typeof createDetectedAgentsSlice | typeof createRuntimeDetectedAgentsSlice
): string[] {
  const store = create<AppState>()((...args) => creator(...args) as AppState)
  return Object.keys(store.getState())
}

describe('detected-agent slice ownership', () => {
  it('keeps runtime detection state out of the local and SSH slice', () => {
    const detectedKeys = sliceKeys(createDetectedAgentsSlice)
    const runtimeKeys = sliceKeys(createRuntimeDetectedAgentsSlice)

    expect(detectedKeys.filter((key) => runtimeKeys.includes(key))).toEqual([])
  })
})
