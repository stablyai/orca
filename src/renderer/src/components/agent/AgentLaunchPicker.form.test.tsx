// @vitest-environment happy-dom
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, it, vi } from 'vitest'
import { verifyOmniboxPresetIdentity } from './agent-launch-picker-omnibox.test-fixture'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files: [], loading: false, loadError: null })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async (_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog' ? entry.catalog : { seedOptions: {} }
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
const launch = vi.fn()
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps + ordinary and actual omnibox original presets independent after editing their models', async () => {
  await verifyOmniboxPresetIdentity(root, launch)
})
