import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImeInput } from '@/lib/ime-text-field'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { buildNativeChatBtwPrompt } from '../../../../shared/native-chat-btw'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type NativeChatBtwState = {
  open: boolean
  question: string
  draft: string
  answer: string | null
  error: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
}

export type NativeChatBtwAsk = (
  question: string,
  messages: readonly NativeChatMessage[]
) => Promise<{ success: true; answer: string } | { success: false; error: string }>

const closed: NativeChatBtwState = {
  open: false,
  question: '',
  draft: '',
  answer: null,
  error: null,
  status: 'idle'
}

function sideQuestionFailedMessage(): string {
  return translate('components.native-chat.btw.failed', 'Could not answer the side question.')
}

export function nativeChatSessionModelId(
  snapshot: readonly SessionOptionDescriptor[]
): string | undefined {
  const row = snapshot.find((entry) => entry.id === 'model')
  return row?.kind.type === 'select' ? row.kind.currentValue : undefined
}

function createNativeChatBtwAsk(args: {
  agent: string
  cwd: string
  model?: string
  runtimeEnvironmentId: string | null
}): NativeChatBtwAsk {
  return async (question, messages) => {
    const payload = {
      agent: args.agent,
      question,
      prompt: buildNativeChatBtwPrompt(messages, question),
      cwd: args.cwd,
      ...(args.model ? { model: args.model } : {})
    }
    if (args.runtimeEnvironmentId) {
      const target: RuntimeClientTarget = {
        kind: 'environment',
        environmentId: args.runtimeEnvironmentId
      }
      return await callRuntimeRpc<
        { success: true; answer: string } | { success: false; error: string }
      >(target, 'nativeChat.askSideQuestion', payload, { timeoutMs: 90_000 })
    }
    return window.api.nativeChat.askSideQuestion(payload)
  }
}

export function useNativeChatBtw(args: {
  messages: readonly NativeChatMessage[]
  ask: NativeChatBtwAsk
}): {
  state: NativeChatBtwState
  ask: (question: string) => void
  dismiss: () => void
  setDraft: (draft: string) => void
} {
  const [state, setState] = useState<NativeChatBtwState>(closed)
  const requestIdRef = useRef(0)
  const { messages, ask } = args

  const run = useCallback(
    async (question: string) => {
      const trimmed = question.trim()
      const requestId = ++requestIdRef.current
      if (!trimmed) {
        setState({
          open: true,
          question: '',
          draft: '',
          answer: null,
          error: null,
          status: 'idle'
        })
        return
      }
      setState({
        open: true,
        question: trimmed,
        draft: trimmed,
        answer: null,
        error: null,
        status: 'loading'
      })
      try {
        const result = await ask(trimmed, messages)
        if (requestId !== requestIdRef.current) {
          return
        }
        setState((current) => {
          if (!current.open) {
            return current
          }
          return result.success
            ? { ...current, status: 'ready', answer: result.answer, error: null }
            : { ...current, status: 'error', error: result.error || sideQuestionFailedMessage() }
        })
      } catch (error) {
        if (requestId !== requestIdRef.current) {
          return
        }
        setState((current) =>
          current.open
            ? {
                ...current,
                status: 'error',
                error:
                  error instanceof Error && error.message
                    ? error.message
                    : sideQuestionFailedMessage()
              }
            : current
        )
      }
    },
    [ask, messages]
  )

  return {
    state,
    ask: run,
    dismiss: () => {
      requestIdRef.current += 1
      setState(closed)
    },
    setDraft: (draft) => setState((current) => ({ ...current, draft }))
  }
}

function NativeChatBtwOverlay({
  state,
  onDismiss,
  onAsk,
  onDraftChange
}: {
  state: NativeChatBtwState
  onDismiss: () => void
  onAsk: (question: string) => void
  onDraftChange: (draft: string) => void
}): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!state.open) {
      return
    }
    if (state.question) {
      dialogRef.current?.focus()
    } else {
      inputRef.current?.focus()
    }
  }, [state.open, state.question])

  if (!state.open) {
    return null
  }

  const title = translate('components.native-chat.btw.title', 'By the way')
  const closeLabel = translate('components.native-chat.btw.close', 'Close')
  const placeholder = translate('components.native-chat.btw.placeholder', 'Ask a side question…')
  const answering = translate('components.native-chat.btw.answering', 'Answering…')

  return (
    <div
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-label={title}
      data-native-chat-typing-redirect-ignore="true"
      data-native-chat-btw-overlay="true"
      className="absolute right-4 bottom-3 left-4 z-20 mx-auto max-w-lg rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-floating outline-none backdrop-blur-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X size={14} />
        </Button>
      </div>
      {state.question ? (
        <p className="mt-1 text-sm text-foreground">{state.question}</p>
      ) : (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault()
            onAsk(state.draft)
          }}
        >
          <ImeInput
            ref={inputRef}
            type="text"
            value={state.draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="w-full rounded-md border border-input bg-input px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </form>
      )}
      {state.status === 'loading' ? (
        <p className="mt-2 text-sm text-muted-foreground">{answering}</p>
      ) : null}
      {state.status === 'error' && state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
      {state.status === 'ready' && state.answer ? (
        <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-foreground scrollbar-sleek">
          {state.answer}
        </p>
      ) : null}
    </div>
  )
}

export function useNativeChatBtwLayer(args: {
  messages: readonly NativeChatMessage[]
  agent: string
  cwd: string
  runtimeEnvironmentId: string | null
  model?: string
  composerRef: RefObject<{ focus: () => boolean } | null>
}): { node: React.JSX.Element; onBtw: (question: string) => void } {
  const ask = createNativeChatBtwAsk(args)
  const btw = useNativeChatBtw({ messages: args.messages, ask })
  return {
    onBtw: btw.ask,
    node: (
      <NativeChatBtwOverlay
        state={btw.state}
        onDismiss={() => {
          btw.dismiss()
          args.composerRef.current?.focus()
        }}
        onAsk={btw.ask}
        onDraftChange={btw.setDraft}
      />
    )
  }
}

export function useStructuredNativeChatBtwLayer(
  props: { agent: string; target: { kind: string; environmentId?: string | null } },
  controller: {
    messages: readonly NativeChatMessage[]
    optionSnapshot: readonly SessionOptionDescriptor[]
  },
  fileLinkContext: { worktreePath?: string } | null,
  composerRef: RefObject<{ focus: () => boolean } | null>
): { node: React.JSX.Element; onBtw: (question: string) => void } {
  return useNativeChatBtwLayer({
    messages: controller.messages,
    agent: props.agent,
    cwd: fileLinkContext?.worktreePath || '.',
    runtimeEnvironmentId:
      props.target.kind === 'local' ? null : (props.target.environmentId ?? null),
    model: nativeChatSessionModelId(controller.optionSnapshot),
    composerRef
  })
}
