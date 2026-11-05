import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat/input/native-chat-slash-commands'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { isAiVaultAgent } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { selectAiVaultPanelWorkspace } from '../right-sidebar/ai-vault/scope/ai-vault-panel-workspace'
import { openAgentSessionHistoryModal } from '../right-sidebar/ai-vault/panel/agent-session-history-modal'
import { getUsageProviderAccountsSectionId } from '../status-bar/usage-provider-settings-target'
import { resolveAccountOwner } from '@/lib/wsl-host-account-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import { findNativeChatTabOwnerWorktreeId } from './native-chat-file-link'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export const NATIVE_CHAT_RESUME_COMMAND = 'resume'
const NATIVE_CHAT_USAGE_COMMAND = 'usage'
const CODEX_ACCOUNTS_SECTION_ID = getUsageProviderAccountsSectionId('codex') ?? undefined

/** Replace the agent’s /resume catalog entry with Orca’s Session History command, and give
 *  Codex /usage, which its app-server cannot run from message text. */
export function withNativeChatOrcaCommands(
  commands: readonly SlashCommandSuggestion[],
  agent: AgentType
): SlashCommandSuggestion[] {
  const resume: SlashCommandSuggestion = {
    name: NATIVE_CHAT_RESUME_COMMAND,
    description: translate(
      'components.native-chat.resumeCommand.description',
      'Open Agent Session History'
    ),
    argumentHint: translate('components.native-chat.resumeCommand.argumentHint', '[search]'),
    orcaOwned: true
  }
  const at = commands.findIndex(({ name }) => name === NATIVE_CHAT_RESUME_COMMAND)
  const withResume =
    at === -1 ? [...commands, resume] : [...commands.slice(0, at), resume, ...commands.slice(at)]
  if (agent !== 'codex' || commands.some(({ name }) => name === NATIVE_CHAT_USAGE_COMMAND)) {
    return withResume
  }
  return [
    ...withResume,
    {
      name: NATIVE_CHAT_USAGE_COMMAND,
      description: translate(
        'components.native-chat.usageCommand.description',
        'View account usage'
      ),
      orcaOwned: true
    }
  ]
}

/** Parse optional /resume search text using host command syntax; null for other drafts. */
export function parseNativeChatResumeDraft(draft: string): string | null {
  const firstToken = draft.split(/\s/, 1)[0] ?? ''
  if (firstToken.toLowerCase() !== `/${NATIVE_CHAT_RESUME_COMMAND}`) {
    return null
  }
  return draft.slice(firstToken.length).replace(/\s+/g, ' ').trim()
}

/** Only a bare /usage is Orca's; text after it stays a message for the agent. */
function isNativeChatUsageDraft(draft: string): boolean {
  return draft.trim().toLowerCase() === `/${NATIVE_CHAT_USAGE_COMMAND}`
}

export type NativeChatOrcaCommands = {
  matchesDraft: (draft: string) => boolean
  /** Runs an Orca command draft; false means the draft is not Orca's. */
  consume: (draft: string) => boolean
  /** Choosing the draft-leading Orca row runs it; mid-prompt it stays an ordinary completion. */
  interceptPick: <TItem extends NativeChatPickerItem>(
    pick: (item: TItem) => void
  ) => (item: TItem) => void
}

/** In a structured chat, `/resume [search]` opens its Session History and Codex `/usage` its
 *  account usage; neither reaches the agent. */
export function useNativeChatOrcaCommands(args: {
  structuredTransport:
    | Pick<NativeChatStructuredComposerTransport, 'worktreeId' | 'runtimeEnvironmentId'>
    | undefined
  agent: AgentType
  terminalTabId: string
  /** Picked skills still reach the agent, even when named like an Orca command. */
  picker: Pick<NativeChatPickerState, 'autocomplete' | 'isPickedSkill' | 'clearSkillOrigin'>
  editor: {
    textareaRef: RefObject<NativeChatComposerInput | null>
    setDraft: (value: string) => void
    setCaret: Dispatch<SetStateAction<number>>
    setActiveSuggestion: Dispatch<SetStateAction<number>>
  }
  setNotice: (notice: string | null) => void
}): NativeChatOrcaCommands {
  const { structuredTransport, agent, terminalTabId } = args
  const { autocomplete, isPickedSkill, clearSkillOrigin } = args.picker
  const { textareaRef, setDraft, setCaret, setActiveSuggestion } = args.editor
  const { setNotice } = args
  const structured = structuredTransport !== undefined
  const structuredWorktreeId = structuredTransport?.worktreeId
  const runtimeEnvironmentId = structuredTransport?.runtimeEnvironmentId ?? null
  const hasUsage = structured && agent === 'codex'

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
        ...(isAiVaultAgent(agent) ? { agent } : {})
      })
      // Attachments stay armed for the next real prompt.
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      setNotice(null)
    },
    [
      agent,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setNotice,
      structuredWorktreeId,
      terminalTabId,
      textareaRef
    ]
  )

  /** Opens Settings and leaves `rest`, the draft past the command, for the next prompt. */
  const openUsage = useCallback(
    (rest = ''): void => {
      const state = useAppStore.getState()
      // The chat's host owns its Codex accounts, as the status bar's usage does for its workspace.
      const { target } = resolveAccountOwner(
        runtimeTargetForOwnerEnvironment(runtimeEnvironmentId),
        state.runtimeEnvironments
      )
      state.openSettingsTarget({
        pane: 'accounts',
        repoId: null,
        hostScope: target,
        sectionId: CODEX_ACCOUNTS_SECTION_ID
      })
      state.openSettingsPage()
      setDraft(rest)
      setCaret(rest.length)
      setActiveSuggestion(0)
      setNotice(null)
    },
    [runtimeEnvironmentId, setActiveSuggestion, setCaret, setDraft, setNotice]
  )

  const matchesDraft = useCallback(
    (draft: string): boolean =>
      structured &&
      !isPickedSkill(draft) &&
      (parseNativeChatResumeDraft(draft) !== null || (hasUsage && isNativeChatUsageDraft(draft))),
    [hasUsage, isPickedSkill, structured]
  )
  const consume = useCallback(
    (draft: string): boolean => {
      if (!matchesDraft(draft)) {
        return false
      }
      const search = parseNativeChatResumeDraft(draft)
      if (search === null) {
        openUsage()
      } else {
        open(search)
      }
      return true
    },
    [matchesDraft, open, openUsage]
  )

  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        const leading = autocomplete.mode === 'slash' && autocomplete.dispatchable
        // An explicit Orca command pick overrides an earlier same-named skill pick.
        const draft = textareaRef.current?.value ?? ''
        if (leading && item.kind === 'command' && item.orcaOwned) {
          clearSkillOrigin()
          if (item.name === NATIVE_CHAT_USAGE_COMMAND) {
            // The pick replaces only the typed command; text after it stays as the draft.
            openUsage(draft.slice((draft.split(/\s/, 1)[0] ?? '').length).trimStart())
            return
          }
          // The caret can sit right after `/resume` with a search already typed past it.
          open(parseNativeChatResumeDraft(draft) ?? '')
          return
        }
        pick(item)
      },
    [autocomplete, clearSkillOrigin, open, openUsage, textareaRef]
  )

  return { consume, interceptPick, matchesDraft }
}
