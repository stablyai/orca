import { useCallback, useContext, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { SlashCommandSuggestion } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import {
  NATIVE_CHAT_RESUME_COMMAND,
  withNativeChatOrcaCommands
} from '../../../../../../shared/native-chat/input/commands/native-chat-orca-commands'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { isAiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { selectAiVaultPanelWorkspace } from '@/components/right-sidebar/ai-vault/scope/ai-vault-panel-workspace'
import { openAgentSessionHistoryModal } from '@/components/right-sidebar/ai-vault/panel/agent-session-history-modal'
import { usePreloadAgentSessionHistoryDialog } from '@/components/right-sidebar/ai-vault/session-list/agent-session-history-dialog-preload'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { NativeChatPickerState } from '@/components/native-chat/composer/pickers/use-native-chat-picker-state'
import { findNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/native-chat-tab-owner'
import {
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from '../editor/native-chat-composer-input'
import { NativeChatSessionHistoryScopeContext } from '../../native-chat-session-history-scope'
import type { NativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/native-chat-structured-composer-transport'

const FORK_DRAFT = /^\/fork(?:\s+([\s\S]*))?$/i
const MCP_DRAFT = /^\/mcp\s*$/i

/** Orca’s /resume, /usage and /fork rows in this app’s words. */
export function withNativeChatResumeCommand(
  commands: readonly SlashCommandSuggestion[],
  accountUsage = false,
  fork = false,
  t: Translate = translate
): SlashCommandSuggestion[] {
  return withNativeChatOrcaCommands(commands, {
    resume: t('components.native-chat.resumeCommand.description', 'Open Agent Session History'),
    resumeArgumentHint: t('components.native-chat.resumeCommand.argumentHint', '[search]'),
    ...(accountUsage
      ? {
          usage: t(
            'components.native-chat.usage.description',
            'Show usage for this chat’s Codex account'
          )
        }
      : {}),
    ...(fork
      ? {
          fork: t(
            'components.native-chat.fork.commandDescription',
            'Fork this chat from its latest response'
          )
        }
      : {})
  })
}

/** Parse optional /resume search text using host command syntax; null for other drafts. */
export function parseNativeChatResumeDraft(draft: string): string | null {
  const firstToken = draft.split(/\s/, 1)[0] ?? ''
  if (firstToken.toLowerCase() !== `/${NATIVE_CHAT_RESUME_COMMAND}`) {
    return null
  }
  return draft.slice(firstToken.length).replace(/\s+/g, ' ').trim()
}

export type NativeChatResumeCommand = {
  matchesDraft: (draft: string) => boolean
  /** Opens Session History for a `/resume` draft; false means the draft is not Orca's. */
  consume: (draft: string) => boolean
  /** Choosing the draft-leading Orca row runs it; mid-prompt it stays an ordinary completion. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void
  ) => (item: TItem) => void
}

/** In a structured chat, `/resume [search]` opens its Session History and `/fork` forks it; neither
 *  reaches the agent. */
export function useNativeChatResumeCommand(args: {
  structuredTransport:
    | Pick<
        NativeChatStructuredComposerTransport,
        'worktreeId' | 'accountUsage' | 'fork' | 'mcpPanel'
      >
    | undefined
  agent: AgentType
  terminalTabId: string
  /** Picked skills still reach the agent, even when named resume. */
  picker: Pick<NativeChatPickerState, 'autocomplete' | 'isPickedSkill' | 'clearSkillOrigin'>
  editor: {
    textareaRef: RefObject<NativeChatComposerInput | null>
    setDraft: (value: string) => void
    setCaret: Dispatch<SetStateAction<number>>
    setActiveSuggestion: Dispatch<SetStateAction<number>>
  }
  setNotice: (notice: string | null) => void
}): NativeChatResumeCommand {
  const { structuredTransport, agent, terminalTabId } = args
  const { autocomplete, isPickedSkill, clearSkillOrigin } = args.picker
  const { textareaRef, setDraft, setCaret, setActiveSuggestion } = args.editor
  const { setNotice } = args
  const structured = structuredTransport !== undefined
  const structuredWorktreeId = structuredTransport?.worktreeId
  usePreloadAgentSessionHistoryDialog(structured)
  // A room's history spans its members' agents; with no chat agent, nothing replaces the room.
  const ownConversation = useContext(NativeChatSessionHistoryScopeContext) === 'conversation'
  const usage = structuredTransport?.accountUsage
  const fork = structuredTransport?.fork
  const mcp = structuredTransport?.mcpPanel
  const openPanel = useCallback(
    (draft: string, panel: { open: () => void } | undefined): void => {
      const rest = draft.replace(/^\/\S+\s*/, '')
      // Focus before opening so closing the modal returns to the editor even after a Send click.
      textareaRef.current?.focus()
      panel?.open()
      setDraft(rest)
      setCaret(rest.length)
      setActiveSuggestion(0)
      setNotice(null)
      // The editor owns its selection; state alone leaves the caret where the command was.
      const input = textareaRef.current
      if (input) {
        writeNativeChatComposerText(input, rest, rest.length)
      }
    },
    [setDraft, setCaret, setActiveSuggestion, setNotice, textareaRef]
  )

  const runFork = useCallback(
    (draft: string): void => {
      // Why: a message after /fork has nowhere to go yet; dropping it silently would lose it.
      const notice = FORK_DRAFT.exec(draft.trim())?.[1]?.trim()
        ? translate(
            'components.native-chat.fork.commandTakesNoText',
            'Send /fork on its own, then write in the new chat.'
          )
        : (fork?.run() ?? null)
      setNotice(notice)
      if (notice !== null) {
        return
      }
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      const input = textareaRef.current
      if (input) {
        writeNativeChatComposerText(input, '', 0)
      }
    },
    [fork, setActiveSuggestion, setCaret, setDraft, setNotice, textareaRef]
  )

  const open = useCallback(
    (search: string): void => {
      const state = useAppStore.getState()
      const worktreeId =
        structuredWorktreeId ?? findNativeChatTabOwnerWorktreeId(state, terminalTabId)
      // Use the active execution host when the on-screen workspace ID matches.
      const executionHostId =
        worktreeId === state.activeWorktreeId
          ? (state.activeWorkspaceExecutionHostId ?? undefined)
          : undefined
      const workspace = worktreeId
        ? { worktreeId, ...(executionHostId ? { executionHostId } : {}) }
        : null
      // Refuse unresolved ownership so Workspace cannot silently open another workspace’s history.
      if (!workspace || !selectAiVaultPanelWorkspace(state, workspace).worktree) {
        setNotice(
          translate(
            'components.native-chat.resumeCommand.workspaceUnavailable',
            "This chat's workspace isn't loaded yet. Try /resume again in a moment."
          )
        )
        return
      }
      // Focus before opening so dialog restoration returns to the editor even after a Send click.
      textareaRef.current?.focus()
      openAgentSessionHistoryModal({
        workspace,
        chatTabId: terminalTabId,
        initialQuery: search,
        ...(!ownConversation
          ? { alongside: true as const }
          : isAiVaultAgent(agent)
            ? { agent }
            : {})
      })
      // Attachments stay armed for the next real prompt.
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      setNotice(null)
    },
    [
      agent,
      ownConversation,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setNotice,
      structuredWorktreeId,
      terminalTabId,
      textareaRef
    ]
  )

  const matchesDraft = useCallback(
    (draft: string): boolean =>
      structured &&
      !isPickedSkill(draft) &&
      (parseNativeChatResumeDraft(draft) !== null ||
        (usage !== undefined && /^\/usage\s*$/i.test(draft)) ||
        // Before goal mode too, so `/mcp` never becomes an objective.
        (mcp !== undefined && MCP_DRAFT.test(draft)) ||
        (fork !== undefined && FORK_DRAFT.test(draft.trim()))),
    [fork, isPickedSkill, mcp, structured, usage]
  )
  const consume = useCallback(
    (draft: string): boolean => {
      if (!matchesDraft(draft)) {
        return false
      }
      if (/^\/usage\s*$/i.test(draft)) {
        openPanel(draft, usage)
      } else if (MCP_DRAFT.test(draft)) {
        openPanel(draft, mcp)
      } else if (fork && FORK_DRAFT.test(draft.trim())) {
        runFork(draft)
      } else {
        open(parseNativeChatResumeDraft(draft) ?? '')
      }
      return true
    },
    [fork, matchesDraft, mcp, open, openPanel, runFork, usage]
  )

  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        const leading = autocomplete.mode === 'slash' && autocomplete.dispatchable
        // An explicit Orca command pick overrides an earlier same-named skill pick.
        if (leading && item.kind === 'command' && item.orcaOwned) {
          if (
            item.name !== 'resume' &&
            !(item.name === 'usage' && usage) &&
            !(item.name === 'mcp' && mcp) &&
            !(item.name === 'fork' && fork)
          ) {
            pick(item)
            return
          }
          clearSkillOrigin()
          if (item.name === 'usage' || item.name === 'mcp') {
            openPanel(textareaRef.current?.value ?? '', item.name === 'usage' ? usage : mcp)
            return
          }
          if (item.name === 'fork') {
            // The picked token may be partial (`/fo`) with text already typed past it.
            const rest = (textareaRef.current?.value ?? '').replace(/^\/\S*/, '')
            runFork(`/fork${rest}`)
            return
          }
          // The caret can sit right after `/resume` with a search already typed past it.
          open(parseNativeChatResumeDraft(textareaRef.current?.value ?? '') ?? '')
          return
        }
        pick(item)
      },
    [autocomplete, clearSkillOrigin, fork, mcp, open, openPanel, runFork, textareaRef, usage]
  )

  return { consume, interceptPick, matchesDraft }
}
