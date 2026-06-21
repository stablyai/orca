import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type {
  JcodeConversationSummary,
  JcodeCustomProvider
} from '../../../../shared/jcode-chat-types'
import { launchChatAgentTab, reopenChatConversation } from '@/lib/launch-chat-agent-tab'
import { JcodeToolCard } from './JcodeToolCard'
import {
  addChatAttachments,
  clearChatAttachments,
  deleteChatConversation,
  hydrateChatSession,
  listChatConversations,
  removeChatAttachment,
  setChatComposerSelection,
  setChatSessionContext,
  setChatStatusDetail,
  startChatTurn,
  useChatSession
} from './chat-session-store'
import { ChatComposer } from './ChatComposer'

// Stable empty reference so the useAppStore selector fallback doesn't produce a
// new array each render (which would thrash the subscription).
const EMPTY_CUSTOM_PROVIDERS: JcodeCustomProvider[] = []

// Why (BUG 1/2, reopen): the empty state of a chat tab is a self-contained,
// chat-feature-owned place to surface "Recent chats" — durable conversations
// persisted to disk. Clicking one recreates its chat tab (reusing the stored
// sessionKey as the tab id) and rehydrates the transcript. This is intentionally
// NOT wired into orca's general PTY-agent sidebar (WorktreeCardAgents), which is
// a different system; see notImplemented in the handoff.
function RecentChats({
  worktreeId,
  excludeSessionKey
}: {
  worktreeId?: string
  excludeSessionKey: string
}): React.JSX.Element | null {
  const [recents, setRecents] = useState<JcodeConversationSummary[]>([])

  const refresh = useCallback(() => {
    void listChatConversations().then((rows) =>
      setRecents(rows.filter((row) => row.sessionKey !== excludeSessionKey))
    )
  }, [excludeSessionKey])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (recents.length === 0) {
    return null
  }

  return (
    <div className="mt-6 w-full max-w-md text-left">
      <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Recent chats
      </div>
      <div className="flex flex-col gap-1">
        {recents.slice(0, 8).map((row) => (
          <div
            key={row.sessionKey}
            className="group flex items-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-muted"
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                void reopenChatConversation({
                  conversation: row,
                  fallbackWorktreeId: worktreeId
                })
              }}
            >
              <div className="truncate text-sm text-foreground">{row.title}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(row.updatedAt).toLocaleString()}
              </div>
            </button>
            <button
              type="button"
              aria-label="Delete chat"
              className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              onClick={() => {
                deleteChatConversation(row.sessionKey)
                refresh()
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

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
  // "Auto" by default: jcode resolves the best authed provider/model, which the
  // composer chip surfaces as "Auto → <model>". A real id is only passed when a
  // caller pins one.
  provider = 'auto',
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
  const {
    messages,
    isStreaming,
    statusDetail,
    resumeSessionId,
    composerProvider,
    composerModel,
    composerProviderProfile,
    pendingAttachments
  } = useChatSession(sessionKey)
  // Custom OpenAI-compatible profiles the user added in Settings. Defensive
  // against settings not yet hydrated.
  const customProviders =
    useAppStore((s) => s.settings?.jcodeCustomProviders) ?? EMPTY_CUSTOM_PROVIDERS
  const [input, setInput] = useState('')
  // FEATURE B: a skill armed from the "/" menu for the next send. Its SKILL.md
  // body is injected into the prompt by the main process at send time; here we
  // only carry the name (and show a chip). Cleared after each send.
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Why (BUG 1, persistence): register this pane's context so disk snapshots are
  // complete, and rehydrate from disk on mount for a known conversation. The
  // store's hydrate is a no-op when the session already has live in-memory
  // messages (kept across a tab switch), so this only fills an empty session
  // after restart or a reopen. Running it on mount keeps tool-card/diff render
  // identical because we round-trip the reduced message shape verbatim.
  useEffect(() => {
    setChatSessionContext(sessionKey, { worktreeId, cwd })
    let cancelled = false
    void window.api.jcodeChat.loadConversation(sessionKey).then((record) => {
      if (!cancelled && record) {
        hydrateChatSession(record)
      }
    })
    return () => {
      cancelled = true
    }
  }, [sessionKey, worktreeId, cwd])

  useEffect(() => {
    const bottom = scrollRef.current
    if (bottom) {
      bottom.scrollTop = bottom.scrollHeight
    }
  }, [messages, statusDetail])

  const send = useCallback(() => {
    const prompt = input.trim()
    const attachments = pendingAttachments
    // Allow sending with attachments only or a skill only (no typed text), but
    // require at least one of the three.
    if ((!prompt && attachments.length === 0 && !selectedSkillName) || isStreaming) {
      return
    }
    // Record a transcript-visible user message. The main process weaves the
    // attachment paths/text into the prompt jcode actually receives (and prepends
    // a selected skill's body); here we append a short human-readable summary so
    // the bubble reflects what was sent — including a "skill: <name>" hint, but
    // NOT the heavy SKILL.md body (kept out of the transcript).
    const parts: string[] = []
    if (prompt) {
      parts.push(prompt)
    }
    const extras: string[] = []
    if (selectedSkillName) {
      extras.push(`skill: ${selectedSkillName}`)
    }
    if (attachments.length > 0) {
      extras.push(
        `Attached: ${attachments
          .map((a) => a.name || (a.kind === 'file' ? a.path : 'text'))
          .join(', ')}`
      )
    }
    if (extras.length > 0) {
      parts.push(`[${extras.join(' · ')}]`)
    }
    const summary = parts.join('\n\n')
    startChatTurn(sessionKey, summary)
    setInput('')
    clearChatAttachments(sessionKey)
    // Skill is single-shot: arm once, consume on this send.
    const skillName = selectedSkillName ?? undefined
    setSelectedSkillName(null)
    const sharedAttachments = attachments.length > 0 ? attachments : undefined
    if (composerProviderProfile) {
      // Custom OpenAI-compatible profile: main emits `--provider-profile <name>`
      // and OMITS `-p`. The model defaults to the profile's, overridable by -m.
      window.api.jcodeChat.send({
        sessionKey,
        prompt,
        attachments: sharedAttachments,
        providerProfile: composerProviderProfile,
        model: composerModel,
        cwd,
        worktreeId,
        resumeSessionId,
        skillName
      })
    } else {
      window.api.jcodeChat.send({
        sessionKey,
        prompt,
        attachments: sharedAttachments,
        // composerProvider undefined ("Auto") falls back to this pane's default.
        provider: composerProvider ?? provider,
        model: composerModel ?? model,
        cwd,
        worktreeId,
        resumeSessionId,
        skillName
      })
    }
  }, [
    input,
    pendingAttachments,
    isStreaming,
    sessionKey,
    provider,
    model,
    composerProvider,
    composerModel,
    composerProviderProfile,
    cwd,
    worktreeId,
    resumeSessionId,
    selectedSkillName
  ])

  const stop = useCallback(() => {
    if (!isStreaming) {
      return
    }
    setChatStatusDetail(sessionKey, 'Stopping…')
    window.api.jcodeChat.stop({ sessionKey })
  }, [isStreaming, sessionKey])

  // Native file picker -> attach the chosen ABSOLUTE paths as removable chips.
  const addFiles = useCallback(() => {
    void window.api.jcodeChat.pickFiles().then((paths) => {
      if (paths.length === 0) {
        return
      }
      addChatAttachments(
        sessionKey,
        paths.map((path) => ({
          kind: 'file' as const,
          path,
          name: path.split('/').pop() || path
        }))
      )
    })
  }, [sessionKey])

  const addText = useCallback(
    (content: string, name?: string) => {
      addChatAttachments(sessionKey, [{ kind: 'text', content, name: name?.trim() || 'Text' }])
    },
    [sessionKey]
  )

  // orca-side "/" actions: /clear opens a fresh chat tab; /resume reopens the
  // most-recent OTHER conversation. Both are orca-provided, not jcode skills.
  const runSlashAction = useCallback(
    (action: 'clear' | 'resume') => {
      if (action === 'clear') {
        if (worktreeId) {
          launchChatAgentTab({ agent: 'jcode', worktreeId })
        }
        return
      }
      void listChatConversations().then((rows) => {
        const last = rows.find((row) => row.sessionKey !== sessionKey)
        if (last) {
          void reopenChatConversation({ conversation: last, fallbackWorktreeId: worktreeId })
        }
      })
    },
    [sessionKey, worktreeId]
  )

  // Native OS drag-and-drop of files onto the chat pane. The preload resolves
  // dropped File objects to absolute paths (renderer cannot) and routes drops
  // landing on a `data-native-file-drop-target="composer"` element here.
  useEffect(() => {
    const unsubscribe = window.api.ui.onFileDrop((data) => {
      if (data.target !== 'composer' || !Array.isArray(data.paths) || data.paths.length === 0) {
        return
      }
      addChatAttachments(
        sessionKey,
        data.paths.map((path) => ({
          kind: 'file' as const,
          path,
          name: path.split('/').pop() || path
        }))
      )
    })
    return unsubscribe
  }, [sessionKey])

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-native-file-drop-target="composer"
    >
      <RemoteExecBanner worktreeId={worktreeId} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="text-base font-medium text-foreground">Message jcode to start</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Replies stream in. Tool calls and diffs render inline.
            </div>
            <RecentChats worktreeId={worktreeId} excludeSessionKey={sessionKey} />
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
          providerProfile={composerProviderProfile}
          model={composerModel}
          customProviders={customProviders}
          onSelectProvider={(selection) => setChatComposerSelection(sessionKey, selection)}
          attachments={pendingAttachments}
          onAddFiles={addFiles}
          onAddText={addText}
          onRemoveAttachment={(index) => removeChatAttachment(sessionKey, index)}
          onSlashAction={runSlashAction}
          cwd={cwd}
          worktreeId={worktreeId}
          selectedSkillName={selectedSkillName}
          onSelectSkill={setSelectedSkillName}
        />
      </div>
    </div>
  )
}
