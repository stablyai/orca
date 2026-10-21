import { toast } from 'sonner'
import type { MachineActionResult, MachineRecord } from '../../../../shared/machine-inventory'
import type { MachineAccess } from '../../../../shared/machine-provider-protocol'
import { quotePosixShellUnlessPlain } from '../../../../shared/shell-argument-quoting'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { getMachineActions, type MachineAction } from '../../../../shared/machine-display'
import { getMachineDisplayState } from './machine-display-state'
import { type MachineMatch, worktreesOnMachine } from './machine-host-match'
import { describeMachineActionFailure, describeMachineFailure } from './machine-copy'
import { getWorkingAgentsPerWorktree } from '@/lib/agent-status'
import { useAppStore } from '@/store'
import { applyEnvironmentMachineResult, loadEnvironmentMachines } from '@/store/machines'
import { wakeMachine } from './machine-wake'

export type MachineMenuAction = MachineAction

/** `ssh` for a running machine's SSH access, or null when there is nothing to dial. */
export function buildMachineSshCommand(access: MachineAccess | undefined): string | null {
  if (!access || access.kind !== 'ssh') {
    return null
  }
  const args = ['ssh']
  if (access.jumpHost) {
    args.push('-J', access.jumpHost)
  }
  if (access.port !== 22) {
    args.push('-p', String(access.port))
  }
  args.push(`${access.user}@${access.host}`)
  return args.map(quotePosixShellUnlessPlain).join(' ')
}

/** Only actions that can work right now; the rules are shared with every other surface. */
export function getMachineMenuActions(match: MachineMatch): MachineMenuAction[] {
  return getMachineActions({
    state: match.machine.state,
    verbs: match.snapshot.capabilities?.verbs ?? [],
    local: match.environmentId === null,
    // Why: a paired server's access names its own jump host, which this computer may not reach.
    sshCommandAvailable: buildMachineSshCommand(match.machine.access) !== null
  })
}

export function getMachineMenuActionLabel(action: MachineMenuAction, match: MachineMatch): string {
  switch (action) {
    case 'wake':
      return translate('auto.lib.machines.machineActions.wakeMachine', 'Wake machine')
    case 'sleep':
      return translate('auto.lib.machines.machineActions.sleepMachine', 'Sleep machine')
    case 'archive':
      return translate('auto.lib.machines.machineActions.archive', 'Archive')
    case 'copy-ssh':
      return translate('auto.lib.machines.machineActions.copySsh', 'Copy SSH command')
    case 'refresh':
      return ['unreachable', 'error'].includes(getMachineDisplayState(match.machine.state))
        ? translate('auto.lib.machines.machineActions.retry', 'Retry')
        : translate('auto.lib.machines.machineActions.refresh', 'Refresh')
    case 'delete':
      return translate('auto.lib.machines.machineActions.delete', 'Delete…')
  }
}

async function runMutation(
  verb: 'wake' | 'sleep' | 'archive',
  match: MachineMatch
): Promise<MachineActionResult<MachineRecord>> {
  const target = { providerKey: match.snapshot.providerKey, machineId: match.machine.id }
  if (verb === 'wake') {
    // Why: one wake per machine; a menu Wake joins one already started by opening a worktree.
    return wakeMachine(target, { environmentId: match.environmentId })
  }
  if (match.environmentId !== null) {
    // Why: archive is desktop-local, so the menu never offers it for a paired server.
    const result = await callRuntimeRpc<MachineActionResult<MachineRecord>>(
      { kind: 'environment', environmentId: match.environmentId },
      'machines.sleep',
      target
    )
    applyEnvironmentMachineResult(match.environmentId, result)
    return result
  }
  return window.api.machines[verb](target)
}

/** Runs every action but Delete, which confirms first in its own dialog. */
export async function runMachineMenuAction(
  action: Exclude<MachineMenuAction, 'delete'>,
  match: MachineMatch
): Promise<void> {
  if (action === 'copy-ssh') {
    const command = buildMachineSshCommand(match.machine.access)
    if (command) {
      await window.api.ui.writeClipboardText(command)
      toast.success(translate('auto.lib.machines.machineActions.copied', 'SSH command copied'))
    }
    return
  }
  if (action === 'refresh') {
    if (match.environmentId !== null) {
      await loadEnvironmentMachines(match.environmentId, { refresh: true })
      return
    }
    const listed = await window.api.machines
      .list({ providerKey: match.snapshot.providerKey, force: true })
      .catch(() => null)
    if (!listed?.ok) {
      toast.error(
        translate(
          'auto.lib.machines.machineActions.refreshFailed',
          'Couldn’t refresh {{provider}}',
          {
            provider: match.snapshot.name
          }
        ),
        listed ? { description: describeMachineFailure(listed.code) } : undefined
      )
    }
    return
  }
  if (action === 'sleep') {
    const working = countWorkingAgentsOnMachine(match)
    if (working > 0) {
      // Why: sleeping stops the machine's terminals, so a running agent's work needs a yes first.
      toast.warning(
        working === 1
          ? translate(
              'auto.lib.machines.machineActions.sleepAgentsOne',
              '1 agent is working on {{name}}',
              { name: match.machine.name }
            )
          : translate(
              'auto.lib.machines.machineActions.sleepAgents',
              '{{count}} agents are working on {{name}}',
              { count: working, name: match.machine.name }
            ),
        {
          description: translate(
            'auto.lib.machines.machineActions.sleepAgentsBody',
            'Sleeping the machine stops them.'
          ),
          action: {
            label: translate('auto.lib.machines.machineActions.sleepAnyway', 'Sleep anyway'),
            onClick: () => void runMutationWithFeedback('sleep', match)
          }
        }
      )
      return
    }
  }
  await runMutationWithFeedback(action, match)
}

/** Agents working in terminals of worktrees on this machine, wherever its provider runs. */
export function countWorkingAgentsOnMachine(match: MachineMatch): number {
  const state = useAppStore.getState()
  const working = getWorkingAgentsPerWorktree(state)
  return worktreesOnMachine(match, state).reduce(
    (total, worktree) => total + (working[worktree.id]?.agents.length ?? 0),
    0
  )
}

async function runMutationWithFeedback(
  action: 'wake' | 'sleep' | 'archive',
  match: MachineMatch
): Promise<void> {
  const result = await runMutation(action, match).catch(
    (error: unknown): MachineActionResult<MachineRecord> => ({
      ok: false,
      code: 'unavailable',
      message: error instanceof Error ? error.message : String(error)
    })
  )
  if (!result.ok) {
    // Why: the provider's own words are transport detail; the toast says what it means.
    console.warn(`[machines] ${action} ${match.machine.name} failed:`, result.message)
    toast.error(mutationFailedTitle(action, match.machine.name), {
      description: describeMachineActionFailure(result.code, match.machine.name)
    })
  }
}

function mutationFailedTitle(action: 'wake' | 'sleep' | 'archive', name: string): string {
  switch (action) {
    case 'wake':
      return translate('auto.lib.machines.machineActions.wakeFailed', 'Couldn’t wake {{name}}', {
        name
      })
    case 'sleep':
      return translate(
        'auto.lib.machines.machineActions.sleepFailed',
        'Couldn’t put {{name}} to sleep',
        {
          name
        }
      )
    case 'archive':
      return translate(
        'auto.lib.machines.machineActions.archiveFailed',
        'Couldn’t archive {{name}}',
        {
          name
        }
      )
  }
}
