// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_FILE_PATH_MIME } from './workspace-file-drag'
import {
  disarmWorkspaceFileDrag,
  getWorkspaceFileDragActiveSnapshot,
  resetWorkspaceFileDragActivityForTests,
  subscribeToWorkspaceFileDragActivity
} from './workspace-file-drag-activity'

type Registration = { capture: boolean; type: string }

let registrations: Registration[] = []
let addSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  registrations = []
  addSpy = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation((type: string, _listener: unknown, options?: unknown) => {
      registrations.push({ capture: options === true, type })
    })
})

afterEach(() => {
  addSpy.mockRestore()
  resetWorkspaceFileDragActivityForTests()
})

function phaseOf(type: string): boolean | undefined {
  return registrations.find((entry) => entry.type === type)?.capture
}

describe('workspace file drag activity listeners', () => {
  it('reads dragstart on the bubble phase, after React delegation has run setData', () => {
    subscribeToWorkspaceFileDragActivity(() => {})
    expect(phaseOf('dragstart')).toBe(false)
  })

  it('keeps a capture-phase dragenter backstop for sources that stop dragstart short', () => {
    subscribeToWorkspaceFileDragActivity(() => {})
    expect(phaseOf('dragenter')).toBe(true)
  })

  it('does not tear the drop zones down on a capture-phase drop', () => {
    // Why: disarming during capture unmounts the drop target before React's
    // delegated onDrop runs at the root, and the drop is silently lost.
    subscribeToWorkspaceFileDragActivity(() => {})
    expect(phaseOf('drop')).toBe(false)
  })
})

describe('disarmWorkspaceFileDrag', () => {
  it('clears the armed snapshot and notifies subscribers', () => {
    addSpy.mockRestore()
    const onChange = vi.fn()
    subscribeToWorkspaceFileDragActivity(onChange)

    const dragStart = new Event('dragstart', { bubbles: true })
    Object.defineProperty(dragStart, 'dataTransfer', {
      value: { types: [WORKSPACE_FILE_PATH_MIME] }
    })
    window.dispatchEvent(dragStart)
    expect(getWorkspaceFileDragActiveSnapshot()).toBe(true)

    onChange.mockClear()
    disarmWorkspaceFileDrag()
    expect(getWorkspaceFileDragActiveSnapshot()).toBe(false)
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
