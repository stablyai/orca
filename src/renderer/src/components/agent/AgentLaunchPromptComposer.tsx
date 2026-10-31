import { useMemo, type Ref } from 'react'
import { useAppStore } from '@/store'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import {
  NativeChatComposer,
  type NativeChatComposerHandle
} from '../native-chat/NativeChatComposer'
import type { NativeChatStructuredComposerTransport } from '../native-chat/native-chat-composer-types'
import type { NativeChatComposerNotice } from '../native-chat/native-chat-composer-notice'
import { useNativeChatComposerError } from '../native-chat/use-native-chat-composer-notice'
import {
  nativeChatLaunchPromptDraftScopeKey,
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftIfUnchanged
} from '../native-chat/native-chat-composer-draft-store'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

const NO_OPTIONS_SURFACE: SessionOptionsSurface = {
  getSnapshot: () => [],
  setOption: async () => ({ snapshot: [] }),
  invokeAction: async () => ({ snapshot: [] }),
  subscribe: () => () => {}
}
const NO_COMMAND_CAUSES = {
  working: false,
  prompt: false,
  background: false,
  sending: false,
  retry: false
} as const

/** One prompt per agent and workspace owner, kept while the panel closes and reopens. */
export function agentLaunchPromptScopeKey(entry: AgentPickerEntry): string {
  return nativeChatLaunchPromptDraftScopeKey(
    entry.worktreeId ?? '',
    entry.agent,
    entry.rows[0]?.executionHostId ?? 'local'
  )
}

/** The chat composer as a launch's first prompt: sending it is the launch, so nothing reaches a session. */
export function AgentLaunchPromptComposer({
  entry,
  composerRef,
  disabled,
  onLaunch
}: {
  entry: AgentPickerEntry
  composerRef: Ref<NativeChatComposerHandle>
  disabled?: boolean
  onLaunch: (prompt: string) => boolean | void | Promise<boolean>
}): React.JSX.Element {
  const scopeKey = agentLaunchPromptScopeKey(entry)
  const { worktreeId } = entry
  const runtimeEnvironmentId = useAppStore((state) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  )
  const { composerError, reportComposerError } = useNativeChatComposerError(NO_COMMAND_CAUSES)
  const transport = useMemo(
    (): NativeChatStructuredComposerTransport => ({
      capturePresentation: () => () => true,
      // Commands go to the agent in its first prompt, as typed.
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      send: (text, _attachments, request) => {
        // Launches carry text only; name the exact selected files instead of losing skill identity.
        const skills = request?.skills ?? []
        const prompt = skills.length
          ? `${text}\n\nUse these selected skill files:\n${skills
              .map(({ name, path }) => `${name}: ${formatNativeChatFileReference(path)}`)
              .join('\n')}`
          : text
        const result = onLaunch(prompt)
        return result instanceof Promise ? result : result !== false
      },
      optionsSurface: NO_OPTIONS_SURFACE,
      optionSnapshot: [],
      // A launch carries text: an attached image goes by its path, as for agents without image input.
      acceptsImages: false,
      ...(worktreeId ? { worktreeId } : {}),
      onError: reportComposerError,
      runtime: runtimeEnvironmentId ? 'remote' : 'local',
      sessionId: scopeKey,
      runtimeEnvironmentId,
      // A paired server holds no session for this prompt to upload a file into yet.
      ...(runtimeEnvironmentId ? { sessionPending: true } : {})
    }),
    [onLaunch, reportComposerError, runtimeEnvironmentId, scopeKey, worktreeId]
  )
  const notices = useMemo(
    (): NativeChatComposerNotice[] =>
      composerError ? [{ key: 'composer-error', kind: 'error', ...composerError }] : [],
    [composerError]
  )
  const launchPrompt = useMemo(
    () => ({
      onEmptySubmit: () => {
        const submitted = readNativeChatComposerDraft(scopeKey)
        if (onLaunch('') !== false) {
          clearNativeChatComposerDraftIfUnchanged(scopeKey, submitted)
        }
      },
      placeholder: getNativeChatAgentProfile(entry.agent)
        ? translate(
            'agentPicker.promptPlaceholder',
            'Add a prompt (optional): / for skills, @ for files'
          )
        : translate(
            'agentPicker.promptPlaceholderFilesOnly',
            'Add a prompt (optional): @ for files'
          )
    }),
    [entry.agent, onLaunch, scopeKey]
  )
  return (
    <NativeChatComposer
      ref={composerRef}
      terminalTabId={scopeKey}
      paneKey={scopeKey}
      draftScopeKey={scopeKey}
      targetPtyId={null}
      agent={entry.agent}
      canSend={!disabled}
      structuredTransport={transport}
      notices={notices}
      launchPrompt={launchPrompt}
    />
  )
}
