import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { collectAgentSessionRestartPlanFromState } from './agent-session-restart-service'
import { getMountedAgentSessionRestart } from './agent-session-restart-mounted'
import type { AgentSessionRestartPane } from './agent-session-restart-plan'

/** Explicit command restart is separate from the automatic exact-resume path. */
export async function restartAgentWithConfirmedCommand(
  expected: AgentSessionRestartPane,
  command: string
): Promise<void> {
  if (
    [...command].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new Error('Enter a single command without line breaks or control characters.')
  }
  if (!command.trim()) {
    throw new Error('Enter the command to run.')
  }
  const state = useAppStore.getState()
  const target = collectAgentSessionRestartPlanFromState(state).targets.find(
    (item) => item.pane.ptyId === expected.ptyId
  )
  const pane = target?.pane
  if (
    !pane ||
    pane.tabId !== expected.tabId ||
    pane.leafId !== expected.leafId ||
    pane.tabGeneration !== expected.tabGeneration ||
    pane.worktreeId !== expected.worktreeId ||
    pane.agent !== expected.agent ||
    pane.providerSession?.id !== expected.providerSession?.id ||
    pane.executionHostId !== 'local' ||
    pane.foreignPty ||
    pane.wsl ||
    pane.structuredHostOwned ||
    pane.restoredUnconfirmed ||
    pane.shellForeground ||
    pane.terminalResumeEligible === false ||
    !isTuiAgent(pane.agent)
  ) {
    throw new Error('The terminal changed. Reopen this dialog and try again.')
  }
  const entry = state.agentStatusByPaneKey[makePaneKey(pane.tabId, pane.leafId)]
  if (entry?.state !== 'done') {
    throw new Error('Wait until this agent is idle before restarting.')
  }
  const restart = getMountedAgentSessionRestart(pane.ptyId)
  if (!restart) {
    throw new Error('Open this terminal first, then try again.')
  }
  const agent = pane.agent
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error('Restart has not reported completion. Check the terminal before trying again.')
        ),
      60_000
    )
    const accepted = restart({
      command: command.trim(),
      startupCommandDelivery: 'shell-ready',
      launchAgent: agent,
      onSessionRestartSettled: (result) => {
        clearTimeout(timeout)
        if (
          result?.id &&
          !result.isReattach &&
          !result.deferred &&
          !result.refusedBeforeStop &&
          !result.agentResumeRefused &&
          !result.agentResumeUnavailable &&
          !result.sessionExpired
        ) {
          resolve()
        } else {
          reject(new Error('The replacement process did not start. Check the terminal.'))
        }
      }
    })
    if (!accepted) {
      clearTimeout(timeout)
      reject(new Error('The terminal is not ready. Try again.'))
    }
  })
}
