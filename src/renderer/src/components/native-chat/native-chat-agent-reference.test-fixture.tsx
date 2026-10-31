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

type MentionInput = 'ready' | 'disabled' | 'ime' | 'none' | 'plain' | 'missing-handle'
export function mountedMention(
  crewRows: OrchestrationCrewRow[],
  first: OrchestrationAgentReference,
  managed = false,
  initialValue = 'Hello suffix'
): RenderResult & {
  input: RefObject<NativeChatComposerInput | null>
  handle: RefObject<NativeChatComposerHandle | null>
  setMode: (mode: MentionInput) => void
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
  const absent = createRef<NativeChatComposerHandle>()
  function Pane({ mode }: { mode: MentionInput }) {
    useNativeChatComposerHandle(handle, {
      textareaRef: input,
      isComposing: () => mode === 'ime',
      setDraft: () => {},
      setCaret: () => {},
      setActiveSuggestion: () => {},
      attachmentScopeKey: 'menu',
      targetKey: 'menu',
      disabled: mode === 'disabled',
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
            composerRef={mode === 'missing-handle' ? absent : handle}
          />
          {mode === 'none' ? null : mode === 'plain' ? (
            <textarea
              aria-label="Current input"
              defaultValue={initialValue}
              ref={(node) => {
                input.current = node
              }}
            />
          ) : (
            <NativeChatPromptEditor
              scopeKey="menu"
              inputRef={input}
              initialValue={initialValue}
              disabled={mode === 'disabled'}
              placeholder="Current input"
              onChange={() => {}}
              onSelect={() => {}}
            />
          )}
        </div>
      </TooltipProvider>
    )
  }
  const view = render(<Pane mode="ready" />)
  return {
    ...view,
    input,
    handle,
    setMode: (mode: MentionInput) => view.rerender(<Pane mode={mode} />)
  }
}
