import { createRef, type RefObject } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import type { OrchestrationAgentReference } from '../../../../shared/orchestration-agent-reference'
import { NativeChatCrewPanel } from '../orchestration-crew/NativeChatCrewPanel'
import { TooltipProvider } from '../ui/tooltip'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { useNativeChatComposerHandle } from './use-native-chat-composer-handle'

export function mountedMention(
  crewRows: OrchestrationCrewRow[],
  first: OrchestrationAgentReference,
  managed = false,
  initialValue = 'Hello suffix'
): RenderResult & {
  input: RefObject<NativeChatComposerInput | null>
  handle: RefObject<NativeChatComposerHandle | null>
} {
  crewRows.push({
    partyKey: 'worker',
    role: 'worker',
    label: first.label,
    agentKind: 'codex',
    status: 'working',
    sendAddress: first.address,
    ...(managed ? { task: { title: 'Inspect', state: 'dispatched' as const } } : {})
  })
  const input = createRef<NativeChatComposerInput>()
  const handle = createRef<NativeChatComposerHandle>()
  function Pane() {
    useNativeChatComposerHandle(handle, {
      textareaRef: input,
      isComposing: () => false,
      setDraft: () => {},
      setCaret: () => {},
      setActiveSuggestion: () => {},
      attachmentScopeKey: 'menu',
      targetKey: 'menu',
      disabled: false,
      caret: 6,
      resolveAttachmentOwner: () => ({ kind: 'local' }),
      attachResolvedPaths: () => {},
      attachCopiedFiles: () => {},
      captureCopiedFiles: () => async () => {},
      beginPendingImageAttachment: () => null,
      resolvePendingImageAttachment: () => {},
      dropPendingImageAttachment: () => {},
      setNotice: () => {},
      pastedTextEditor: () => input.current
    })
    return (
      <TooltipProvider>
        <div data-native-chat-root>
          <NativeChatCrewPanel
            target={{ kind: 'environment', environmentId: 'captured-host' }}
            party="term_self"
            canMention
            composerRef={handle}
          />
          <NativeChatPromptEditor
            scopeKey="menu"
            inputRef={input}
            initialValue={initialValue}
            disabled={false}
            placeholder="Current input"
            onChange={() => {}}
            onSelect={() => {}}
          />
        </div>
      </TooltipProvider>
    )
  }
  return { ...render(<Pane />), input, handle }
}
