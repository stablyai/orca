import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { JcodeToolCard } from './JcodeToolCard'
import {
  setChatComposerSelection,
  setChatStatusDetail,
  startChatTurn,
  useChatSession
} from './chat-session-store'
import { ChatComposer } from './ChatComposer'

// Why: M2 enriches the M1 jcode chat-bubble view. Tool calls render as cards
// (name + pretty args + output/error, bash special-cased, diffs colorized);
// text_delta streams smoothly into the assistant bubble; connection_phase shows
// as a subtle status line; 'error' renders an error bubble; the jcode session_id
// from 'start'/'done' is captured and passed as --resume so the conversation
// continues across turns; input is disabled while streaming and a Stop button
// kills the in-flight jcode child. Parsing mirrors the jcode-desktop prototype
// (src/app.js) and the documented --ndjson schema.
//
// Why (BUG 1, persistence): the conversation + --resume id now live in
// chat-session-store (a per-sessionKey external store that subscribes to IPC at
// module level), not in this component's local state. That makes ChatPane safe
// to unmount/remount on tab switches — switching away and back restores the same
// conversation with --resume continuity intact.

/** Minimal brain-local (M3) affordance: for a folder-scoped chat pane whose
 *  workspace has an SSH connection, show whether jcode is running brain-local
 *  (agent local, bash on the remote host via --remote-exec) and let the user
 *  toggle it. The host itself is resolved authoritatively in the main process;
 *  here we only surface the SSH target label and the on/off flag. Renders
 *  nothing for local workspaces or workspaces without an SSH connection. */
function RemoteExecBanner({ worktreeId }: { worktreeId?: string }): React.JSX.Element | null {
  const parsedScope = worktreeId ? parseWorkspaceKey(worktreeId) : null
  const folderWorkspaceId =
    parsedScope?.type === 'folder' ? parsedScope.folderWorkspaceId : undefined
  const workspace = useAppStore((state) =>
    folderWorkspaceId
      ? state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
      : undefined
  )
  const updateFolderWorkspace = useAppStore((state) => state.updateFolderWorkspace)
  const targetLabel = useAppStore((state) =>
    workspace?.connectionId ? (state.sshTargetLabels.get(workspace.connectionId) ?? null) : null
  )

  // Only meaningful when the workspace is bound to an SSH connection: that host
  // is what jcode --remote-exec runs bash on.
  if (!workspace?.connectionId || !folderWorkspaceId) {
    return null
  }
  const enabled = workspace.isRemoteExecOnly === true
  const hostText = targetLabel ?? workspace.connectionId

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-xs">
      <span className="text-muted-foreground">
        {enabled ? (
          <>
            Brain-local: jcode runs locally, bash on <span className="font-medium">{hostText}</span>
          </>
        ) : (
          <>Local jcode (bash also local)</>
        )}
      </span>
      <button
        type="button"
        onClick={() => {
          void updateFolderWorkspace(folderWorkspaceId, { isRemoteExecOnly: !enabled })
        }}
        className={cn(
          'rounded px-2 py-0.5 font-medium',
          enabled
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground hover:bg-muted/80'
        )}
      >
        {enabled ? 'Hands remote: on' : 'Hands remote: off'}
      </button>
    </div>
  )
}

export default function ChatPane({
  sessionKey,
  cwd,
  worktreeId,
  provider = 'openai',
  model
}: {
  sessionKey: string
  cwd?: string
  /** Worktree / folder-workspace key. Threaded to main so it can resolve
   *  brain-local (M3): a remote-exec-only workspace gets --remote-exec <host>. */
  worktreeId?: string
  provider?: string
  model?: string
}): React.JSX.Element {
  // Why: conversation state is read from the external store keyed by sessionKey,
  // so it survives this component unmounting on tab switches. The composer's
  // provider/model selection also lives in the store (composerProvider/Model)
  // so the chip choice persists across tab switches; only the unsent draft text
  // is local component state.
  const { messages, isStreaming, statusDetail, resumeSessionId, composerProvider, composerModel } =
    useChatSession(sessionKey)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const bottom = scrollRef.current
    if (bottom) {
      bottom.scrollTop = bottom.scrollHeight
    }
  }, [messages, statusDetail])

  const send = useCallback(() => {
    const prompt = input.trim()
    if (!prompt || isStreaming) {
      return
    }
    startChatTurn(sessionKey, prompt)
    setInput('')
    window.api.jcodeChat.send({
      sessionKey,
      prompt,
      // composerProvider undefined ("Auto") falls back to this pane's default.
      provider: composerProvider ?? provider,
      model: composerModel ?? model,
      cwd,
      worktreeId,
      resumeSessionId
    })
  }, [
    input,
    isStreaming,
    sessionKey,
    provider,
    model,
    composerProvider,
    composerModel,
    cwd,
    worktreeId,
    resumeSessionId
  ])

  const stop = useCallback(() => {
    if (!isStreaming) {
      return
    }
    setChatStatusDetail(sessionKey, 'Stopping…')
    window.api.jcodeChat.stop({ sessionKey })
  }, [isStreaming, sessionKey])

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <RemoteExecBanner worktreeId={worktreeId} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="text-base font-medium text-foreground">Message jcode to start</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Replies stream in. Tool calls and diffs render inline.
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
            {messages.map((message) => {
              const hasTools = !!message.tools && message.tools.length > 0
              const placeholder =
                message.role === 'assistant' && isStreaming && !hasTools && !message.text ? '…' : ''
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap break-words">
                      {message.text}
                    </div>
                  </div>
                )
              }
              return (
                <div key={message.id} className="flex flex-col gap-2">
                  {hasTools ? (
                    <div className="flex flex-col gap-1.5">
                      {message.tools!.map((tool) => (
                        <JcodeToolCard key={tool.id} call={tool} />
                      ))}
                    </div>
                  ) : null}
                  {message.text || placeholder ? (
                    <div
                      className={cn(
                        'text-sm leading-relaxed whitespace-pre-wrap break-words',
                        message.isError ? 'text-destructive' : 'text-foreground'
                      )}
                    >
                      {message.text || placeholder}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="px-4 pt-1 pb-3">
        {statusDetail ? (
          <div className="mx-auto mb-1.5 w-full max-w-3xl px-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              {statusDetail}
            </span>
          </div>
        ) : null}
        <ChatComposer
          value={input}
          onChange={setInput}
          onSend={send}
          onStop={stop}
          isStreaming={isStreaming}
          provider={composerProvider}
          model={composerModel}
          onSelectProvider={(selection) => setChatComposerSelection(sessionKey, selection)}
        />
      </div>
    </div>
  )
}
