import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'

export const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ agent: 'claude', kind: 'terminal' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: { permissionMode: 'ask' },
  structured: { permissionMode: 'ask' },
  arguments: '--permission-mode plan --add-dir docs',
  catalog: { origin: 'unknown' }
}
export let root: Root
export let host: HTMLDivElement
export const onUse = vi.fn<(draft: AgentPickerDraft) => void>()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onUse.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
