import type { NativeChatHostSetup, NativeChatInstall } from './native-chat-host-setup-view'
export {
  NativeChatHostSetupContext,
  nativeChatSetupAction,
  useNativeChatHostSetupView,
  isNativeChatSetupFailureKind,
  isNativeChatFailureRowResolved,
  type NativeChatHostSetup,
  type NativeChatSignIn
} from './native-chat-host-setup-view'
import {
  useNativeChatSignIn,
  type NativeChatHostSetupInput
} from './use-native-chat-account-sign-in'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { createNativeChatSignInVisibility } from './native-chat-sign-in-visibility'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { readAgentInventoryForTarget } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { runtimeHostPlatform } from '@/components/terminal-pane/pty-transport/host-ownership/pty-owner-machine-platform'
import { agentSessionInstallCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { agentSessionUnresolvedFailureRows } from '../../../../../shared/agent-session/failures/agent-session-visible-failures'
import {
  useNativeChatHostCommandTerminal,
  type NativeChatHostCommandTerminal
} from './native-chat-host-command-terminal'
import { useNativeChatCliUpdate } from './native-chat-cli-update'

function useNativeChatInstall(
  input: NativeChatHostSetupInput,
  terminal: NativeChatHostCommandTerminal | null
): NativeChatInstall | null {
  const { worktreeId, onRechecked } = input
  const environmentId = input.target.kind === 'environment' ? input.target.environmentId : null
  const command = agentSessionInstallCommand(
    input.agent,
    useAppStoreWithHostStatuses((_s, statuses) =>
      environmentId ? runtimeHostPlatform(statuses, environmentId) : getRendererAppPlatform()
    )
  )
  const [opened, setOpened] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const recheck = useCallback(() => {
    const state = useAppStore.getState()
    const reportFailure = () =>
      toast.error(
        translate(
          'components.native-chat.install.cliRecheckFailed',
          'Could not check installed agents on this host. Try again.'
        )
      )
    setRechecking(true)
    void (
      environmentId
        ? state.refreshRuntimeDetectedAgents(environmentId, worktreeId, { userInitiated: true })
        : state.refreshDetectedAgents(worktreeId, { wakeWslDistro: true, userInitiated: true })
    )
      .then(() => {
        // Refreshes can resolve with cached agents after failure; check their explicit outcome.
        const inventory = readAgentInventoryForTarget(
          useAppStore.getState(),
          environmentId
            ? { kind: 'runtime', environmentId, worktreeId }
            : { kind: 'local', worktreeId }
        )
        if (inventory.state === 'successful') {
          setOpened(false)
          onRechecked()
        } else {
          reportFailure()
        }
      })
      .catch(reportFailure)
      .finally(() => setRechecking(false))
  }, [environmentId, worktreeId, onRechecked])
  return useMemo(
    () =>
      command && terminal
        ? {
            phase: opened ? ('recheck' as const) : ('install' as const),
            busy: terminal.opening || rechecking,
            run: opened
              ? recheck
              : () => {
                  void terminal.open(command).then((didOpen) => {
                    if (didOpen) {
                      setOpened(true)
                    }
                  })
                }
          }
        : null,
    [command, terminal, opened, rechecking, recheck]
  )
}

/** Sign-in and install for a chat's own host; each is null where that host can't run it. */
export function useNativeChatHostSetup(input: NativeChatHostSetupInput): NativeChatHostSetup {
  // One terminal for both, so a double press across them can't open two.
  const terminal = useNativeChatHostCommandTerminal(input)
  const signIn = useNativeChatSignIn(input, terminal)
  const visibility = useMemo(() => createNativeChatSignInVisibility(), [])
  useEffect(() => () => visibility.dispose(), [visibility])
  const install = useNativeChatInstall(input, terminal)
  const update = useNativeChatCliUpdate(input.target, input.agent, input.onRechecked)
  const { target, journalItems } = input
  // Keyed by its ids so a streamed reply leaves the set, and the rows reading it, alone.
  const unresolvedKey = useMemo(
    // Sent messages too: a refused one's line can offer the fix.
    () => agentSessionUnresolvedFailureRows(journalItems, { sentMessages: true }).join('\n'),
    [journalItems]
  )
  const unresolvedFailureRows = useMemo(() => new Set(unresolvedKey.split('\n')), [unresolvedKey])
  return useMemo(
    () => ({
      ...signIn,
      install,
      update,
      host: target,
      unresolvedFailureRows,
      visibility,
      failureKey: input.failureKey,
      transcriptFailureId: input.transcriptFailureId
    }),
    [
      signIn,
      install,
      update,
      target,
      unresolvedFailureRows,
      visibility,
      input.failureKey,
      input.transcriptFailureId
    ]
  )
}
