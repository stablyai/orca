import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NativeChatPromptEditor } from '@/components/native-chat/NativeChatPromptEditor'
import { useConversationReferenceDrop } from '@/components/native-chat/use-conversation-reference-drop'
import { useNativeChatRootInputRouting } from '@/components/native-chat/use-native-chat-root-input-routing'
import type { NativeChatComposerHandle } from '../../../src/renderer/src/components/native-chat/native-chat-composer-types'
import type { NativeChatComposerInput } from '../../../src/renderer/src/components/native-chat/native-chat-composer-input'
import { CompactAgentRow } from '@/components/sidebar/worktree-card-compact-agent-row'
import { VaultSessionRow } from '@/components/right-sidebar/AiVaultSessionRow'
import AiVaultSessionDropLayer from '@/components/tab-group/AiVaultSessionDropLayer'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { shouldIgnoreNestedWorktreeContextMenuScope } from '@/components/sidebar/worktree-context-menu-policy'
import { useAppStore } from '@/store'
import {
  conversationReferenceUri,
  withConversationReferenceInstructions,
  type ConversationReferenceCreate
} from '../../../src/shared/conversation-reference'
import { TooltipProvider } from '@/components/ui/tooltip'
import './fixture.css'

const api = {
  aiVault: {
    createConversationReference: async (request: ConversationReferenceCreate) => ({
      uri: conversationReferenceUri('12345678-1234-4234-8234-123456789abc'),
      title: request.title,
      agent: 'claude'
    }),
    getFirstUserPrompt: async () => ({ prompt: 'Original history question.' }),
    listSubagentSessions: async () => ({ sessions: [], issues: [] }),
    readConversationReference: async () => ({
      messages: [
        {
          role: 'assistant',
          text: 'The earlier conversation contains this source answer.',
          messageIndex: 0,
          textOffset: 0
        }
      ],
      nextCursor: null,
      warnings: []
    })
  },
  ui: { writeTerminalClipboardText: async () => undefined }
}
Object.defineProperty(window, 'api', { value: api, configurable: true })

const workspaceId = 'reference-test::/repo'
const sourceAgent: DashboardAgentRow = {
  paneKey: 'source-tab:source-pane',
  tab: {
    id: 'source-tab',
    ptyId: null,
    worktreeId: workspaceId,
    title: 'Claude Code conversation',
    customTitle: 'Claude Code conversation',
    color: null,
    sortOrder: 0,
    createdAt: 1
  },
  agentType: 'claude',
  state: 'done',
  startedAt: 1,
  entry: {
    state: 'done',
    prompt: 'Claude Code conversation',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'source-tab:source-pane',
    stateHistory: [],
    providerSession: { key: 'session_id', id: 'source' }
  }
}
const historySession: AiVaultSession = {
  id: 'local:cursor:history-source',
  executionHostId: 'local',
  agent: 'cursor',
  sessionId: 'history-source',
  title: 'Cursor history conversation',
  cwd: null,
  branch: null,
  model: null,
  filePath: '/history/source.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-25T00:00:00Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [{ role: 'assistant', text: 'Earlier history answer.', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'cursor-agent --resume history-source',
  subagent: null
}
useAppStore.setState({
  tabsByWorktree: { [workspaceId]: [sourceAgent.tab] },
  unifiedTabsByWorktree: { [workspaceId]: [] }
})

function Fixture() {
  const input = useRef<NativeChatComposerInput | null>(null)
  const root = useRef<HTMLElement | null>(null)
  const composer = useRef<NativeChatComposerHandle | null>(null)
  const answerInput = useRef<HTMLInputElement | null>(null)
  useNativeChatRootInputRouting({
    tabId: 'reference-target',
    rootRef: root,
    composerRef: composer,
    questionAnswerInputRef: answerInput,
    isVisible: true,
    isFocusedGroup: true,
    composerReady: false
  })
  const [text, setText] = useState('')
  const [sent, setSent] = useState('')
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [resumed, setResumed] = useState(0)
  const [workspaceMenus, setWorkspaceMenus] = useState(0)
  const drop = useConversationReferenceDrop({
    scope: 'rendered-reference',
    input,
    disabled: false,
    composing: () => false
  })
  return (
    <TooltipProvider>
      <main className="grid min-h-screen grid-cols-1 bg-background text-foreground lg:grid-cols-[256px_minmax(0,1fr)_288px]">
        <aside className="min-w-0 border-r border-border p-4">
          <div
            data-testid="source"
            data-worktree-context-menu-scope="worktree"
            onContextMenuCapture={(event) => {
              if (!shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
                event.preventDefault()
                setWorkspaceMenus((count) => count + 1)
              }
            }}
          >
            <CompactAgentRow agent={sourceAgent} now={2000} onActivate={() => {}} />
          </div>
        </aside>
        <section
          ref={root}
          data-native-chat-root="true"
          className="relative flex min-w-0 flex-1 flex-col justify-end gap-3 p-6 native-chat-appearance"
        >
          <div
            ref={drop.ref}
            data-conversation-reference-drop
            data-testid="composer"
            onDragOver={drop.onDragOver}
            onDrop={drop.onDrop}
            className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-3"
          >
            <NativeChatPromptEditor
              inputRef={input}
              initialValue=""
              placeholder="Message"
              disabled={false}
              className="min-h-20 text-sm text-chat-foreground-strong outline-none"
              onChange={(field) => setText(field.value)}
              onSelect={() => {}}
            />
            <button
              type="button"
              disabled={drop.pending}
              onClick={() => setSent(withConversationReferenceInstructions(text))}
            >
              Send
            </button>
          </div>
          <output data-testid="sent" className="max-h-24 overflow-auto whitespace-pre-wrap text-xs">
            {sent}
          </output>
          <AiVaultSessionDropLayer worktreeId={workspaceId} enabled />
        </section>
        <aside className="min-w-0 border-l border-border" data-testid="history">
          <VaultSessionRow
            session={historySession}
            liveState={null}
            resumeStartup={{ command: historySession.resumeCommand }}
            realHomeResumeStartup={{ command: historySession.resumeCommand }}
            worktreeInfo={null}
            vaultScope="all"
            detailsExpanded={detailsExpanded}
            resumeDisabled={false}
            onToggleDetails={() => setDetailsExpanded((value) => !value)}
            showJumpToWorktree={false}
            onResume={() => setResumed((count) => count + 1)}
            resumeLabel="Resume in New Tab"
            resumeActions={{
              worktree: { worktreeId: null, disabled: true },
              newTab: { worktreeId: null, disabled: true }
            }}
            onResumeInWorktree={() => setResumed((count) => count + 1)}
            onResumeInNewTab={() => setResumed((count) => count + 1)}
            onCopyId={() => {}}
          />
        </aside>
        <output data-testid="resumed">{resumed}</output>
        <output data-testid="workspace-menus">{workspaceMenus}</output>
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
