import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog, getAgentLabel } from './agent-catalog'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { captureBrowserLinkReveal } from './browser-link-reveal'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { showQuickChatFailure, startQuickChat } from './start-quick-chat'
import { isWebClientLocation } from './web-client-location'
import { subscribeUserWorkspaceSwitch } from './workspace-switch-user-act'
import { activateAndRevealWorktree } from './worktree-activation'
import {
  captureNativeChatComposerFocusIntent,
  requestNativeChatComposerFocus
} from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { saveAgentDefaultSurface } from '@/components/settings/native-chat-provider-choice'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { buildDefaultAgentSettingsUpdate } from '../../../shared/default-agent-settings'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentDefaultSurface } from '../../../shared/native-chat/native-chat-appearance-settings'
import {
  normalizeAgentDefaultSurface,
  normalizeNativeChatProviderChoices
} from '../../../shared/native-chat/native-chat-providers'
import type { TuiAgent } from '../../../shared/tui-agent'

export type QuickChatAnswer = { agent: TuiAgent; surface: AgentDefaultSurface }
export type QuickChatDraft = { agent: TuiAgent | null; surface: AgentDefaultSurface }
export type QuickChatPhase = 'idle' | 'committing' | 'failed' | 'done'
export type QuickChatSnapshot = { open: boolean; draft: QuickChatDraft; phase: QuickChatPhase }

type Foreground = ReturnType<typeof captureBrowserLinkReveal>

/** Start chatting's answers: nothing is saved or created until Confirm, and one Confirm runs per window. */
export class QuickChatConfirmation {
  private snapshot: QuickChatSnapshot = {
    open: false,
    draft: { agent: null, surface: 'terminal' },
    phase: 'idle'
  }
  private prefilled: Promise<void> = Promise.resolve()
  private attempt: Promise<void> | null = null
  private listeners = new Set<() => void>()
  read = (): QuickChatSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(next: Partial<QuickChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    this.listeners.forEach((listener) => listener())
  }

  /** Reopening while the draft is open or committing reaches the same draft and attempt. */
  open(): Promise<void> {
    if (isWebClientLocation() || this.snapshot.open) {
      return this.prefilled
    }
    const settings = useAppStore.getState().settings
    const saved = settings?.defaultTuiAgent
    const agent = saved && saved !== 'blank' ? saved : null
    const surface = normalizeAgentDefaultSurface(settings?.agentDefaultSurface)
    this.set({ open: true, phase: 'idle', draft: { agent, surface } })
    // Same pick as first-run setup: a fresh PATH scan, then the first catalog agent found.
    this.prefilled = agent
      ? Promise.resolve()
      : useAppStore
          .getState()
          .refreshDetectedAgents(undefined, { wakeWslDistro: true })
          .then((ids) => {
            const found = getAgentCatalog().find((entry) => ids.includes(entry.id))?.id
            if (found && this.snapshot.open && this.snapshot.draft.agent === null) {
              this.set({ draft: { ...this.snapshot.draft, agent: found } })
            }
          })
          .catch(() => {})
    return this.prefilled
  }

  setDraft(draft: Partial<QuickChatDraft>): void {
    if (this.snapshot.open && this.snapshot.phase !== 'committing') {
      this.set({ draft: { ...this.snapshot.draft, ...draft } })
    }
  }

  /** Refused while committing: saved settings and a registered folder cannot be rolled back. */
  dismiss(): boolean {
    if (this.snapshot.phase === 'committing') {
      return false
    }
    this.set({ open: false, phase: 'idle' })
    return true
  }

  confirm(): Promise<void> {
    if (this.attempt) {
      return this.attempt
    }
    const { open, draft } = this.snapshot
    if (!open || !draft.agent) {
      return Promise.resolve()
    }
    const answer = { agent: draft.agent, surface: draft.surface }
    const foreground = captureForeground()
    this.set({ phase: 'committing' })
    const attempt = this.commit(answer, foreground)
      .catch(() => {
        showQuickChatFailure()
        this.set({ phase: 'failed' })
      })
      .finally(() => {
        foreground.dispose()
        if (this.attempt === attempt) {
          this.attempt = null
        }
      })
    this.attempt = attempt
    return attempt
  }

  private async commit(answer: QuickChatAnswer, foreground: Foreground): Promise<void> {
    try {
      await saveQuickChatAnswer(answer)
    } catch {
      toast.error(
        translate('quickChat.saveFailed', 'Could not save your chat settings. Try again.')
      )
      this.set({ phase: 'failed' })
      return
    }
    if (!foreground.canReveal()) {
      this.set({ open: false, phase: 'idle' })
      return
    }
    // startQuickChat owns its failure notice, and stays silent when Chats was removed meanwhile.
    const destination = await startQuickChat()
    if (!foreground.canReveal()) {
      this.set({ open: false, phase: 'idle' })
      return
    }
    const state = useAppStore.getState()
    const worktree =
      destination &&
      state.repos.some(
        (repo) =>
          repo.id === destination.repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
        ? selectWorktreesByRepo(state)[destination.repoId]?.find(
            (row) => row.id === destination.worktreeId && row.hostId === LOCAL_EXECUTION_HOST_ID
          )
        : undefined
    if (!destination || !worktree) {
      this.set({ phase: 'failed' })
      return
    }
    // Activating Chats is this action's own transition, not the user navigating away.
    foreground.dispose()
    if (
      activateAndRevealWorktree(worktree.id, {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        providesInitialSurface: true
      }) === false
    ) {
      showQuickChatFailure()
      this.set({ phase: 'failed' })
      return
    }
    // The answer is explicit, so launch admission refuses an impossible Chat instead of opening a terminal.
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      focusIntent: captureNativeChatComposerFocusIntent(),
      requestedSurface: answer.surface,
      selectedExecutionHostId: LOCAL_EXECUTION_HOST_ID,
      agent: answer.agent,
      worktreeId: worktree.id,
      groupId: ''
    })
    if (!result) {
      toast.error(
        translate(
          'auto.components.tab.bar.QuickLaunchButton.465e432ef1',
          'Could not build launch command for {{value0}}.',
          { value0: getAgentLabel(answer.agent) }
        )
      )
      this.set({ phase: 'failed' })
      return
    }
    this.set({ open: false, phase: 'done' })
    if (result.surface.kind === 'local-chat') {
      requestNativeChatComposerFocus(result.surface.tabId)
    } else if (result.surface.kind === 'local-terminal') {
      focusTerminalTabSurface(result.surface.tabId)
    }
  }
}

/** Sticky: leaving and coming back, or reselecting a workspace, still ends this action. */
function captureForeground(): Foreground {
  let switched = false
  return captureBrowserLinkReveal(
    useAppStore.getState,
    (observe) => {
      const stopSelection = useAppStore.subscribe(observe)
      const stopSwitch = subscribeUserWorkspaceSwitch(() => {
        switched = true
      })
      return () => {
        stopSelection()
        stopSwitch()
      }
    },
    () => !switched
  )
}

/** One acknowledged write: the answers become the defaults, and the chosen agent drops its own Chat/CLI choice to follow them. */
function saveQuickChatAnswer({ agent, surface }: QuickChatAnswer): Promise<void> {
  const settings = useAppStore.getState().settings
  if (!settings) {
    return Promise.reject(new Error('Settings are not loaded yet.'))
  }
  return saveAgentDefaultSurface({
    surface,
    fallbackSettings: settings,
    updateSettings: (update) => {
      const choices = normalizeNativeChatProviderChoices(
        (useAppStore.getState().settings ?? settings).nativeChatProviders
      )
      const ownChoice = agent in choices
      delete choices[agent]
      return useAppStore.getState().updateSettingsOrThrow({
        ...update,
        ...buildDefaultAgentSettingsUpdate(agent),
        ...(ownChoice ? { nativeChatProviders: choices } : {})
      })
    }
  })
}

export const quickChatConfirmation = new QuickChatConfirmation()
