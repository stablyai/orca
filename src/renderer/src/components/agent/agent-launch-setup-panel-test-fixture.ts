import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

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
  clearNativeChatComposerDraftsForTests()
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

// Render the controlled production view through its real owner, including synchronous current actions.
import { AgentLaunchSetupPanel as SetupPanel } from './AgentLaunchSetupPanel'
import { useAgentPickerDraftScope, useAgentPickerSetup } from './agent-launch-picker-drafts'
export function AgentLaunchSetupPanel({
  initial,
  onDraftChange,
  onUse,
  ...props
}: Omit<ComponentProps<typeof SetupPanel>, 'draft' | 'getDraft' | 'onDraftChange'> & {
  initial?: AgentPickerDraft
  onDraftChange?: (draft: AgentPickerDraft) => void
}) {
  const draftScope = useAgentPickerDraftScope()
  const setup = useAgentPickerSetup({
    entry: props.entry,
    initial,
    draftScope,
    mode: props.mode,
    open: true
  })
  return setup.ready
    ? createElement(SetupPanel, {
        ...props,
        draft: setup.draft,
        getDraft: setup.getDraft,
        onDraftChange: (draft) => {
          setup.change(draft)
          onDraftChange?.(draft)
        },
        onUse: (draft) => {
          const options = { ...draft }
          delete options.prompt
          if (setup.accept(options)) {
            return onUse(draft)
          }
          return false
        }
      })
    : null
}
