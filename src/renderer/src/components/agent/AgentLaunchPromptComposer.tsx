import { useMemo, type Ref } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import {
  NativeChatComposer,
  type NativeChatComposerHandle
} from '../native-chat/NativeChatComposer'
import type { NativeChatStructuredComposerTransport } from '../native-chat/native-chat-composer-types'
import type { NativeChatComposerNotice } from '../native-chat/native-chat-composer-notice'
import { useNativeChatComposerError } from '../native-chat/use-native-chat-composer-notice'
import { nativeChatLaunchPromptDraftScopeKey } from '../native-chat/native-chat-composer-draft-store'
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

/** One prompt per agent and workspace, kept while the panel closes and reopens. */
export function agentLaunchPromptScopeKey(entry: AgentPickerEntry): string {
  return nativeChatLaunchPromptDraftScopeKey(entry.worktreeId ?? '', entry.agent)
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
  onLaunch: (prompt: string) => void
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
      send: (text) => {
        onLaunch(text)
        return true
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
    [entry.agent]
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
