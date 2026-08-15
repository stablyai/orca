import type { TuiAgent } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export type AgentsInstallCliResult = {
  results: {
    agent: TuiAgent
    status: 'installed' | 'already_present' | 'failed' | 'unsupported'
    message?: string
  }[]
}

export async function installMissingAgentsOnRuntime(args: {
  environmentId: string
  environmentName: string
  agents: readonly TuiAgent[]
  clearRuntimeDetectedAgents: (environmentId: string) => void
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
  onSuccess: (message: string) => void
  onError: (message: string) => void
}): Promise<void> {
  try {
    const result = await callRuntimeRpc<AgentsInstallCliResult>(
      { kind: 'environment', environmentId: args.environmentId },
      'agents.installCli',
      { agents: [...args.agents] },
      // Why: sequential multi-agent installs can take several minutes each.
      { timeoutMs: 30 * 60 * 1000 }
    )
    args.clearRuntimeDetectedAgents(args.environmentId)
    void args.ensureRuntimeDetectedAgents(args.environmentId)
    const installed = result.results.filter(
      (entry) => entry.status === 'installed' || entry.status === 'already_present'
    ).length
    const failed = result.results.filter(
      (entry) => entry.status === 'failed' || entry.status === 'unsupported'
    )
    if (failed.length === 0) {
      args.onSuccess(
        translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.agentsInstallSuccessNamed',
          'Installed {{value0}} agent CLI(s) on {{value1}}.',
          { value0: installed, value1: args.environmentName }
        )
      )
      return
    }
    const firstFailure = failed[0]?.message
    args.onError(
      firstFailure
        ? translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.agentsInstallPartialDetail',
            'Installed {{value0}} agent CLI(s); {{value1}} failed. {{value2}}',
            { value0: installed, value1: failed.length, value2: firstFailure }
          )
        : translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.agentsInstallPartial',
            'Installed {{value0}} agent CLI(s); {{value1}} failed.',
            { value0: installed, value1: failed.length }
          )
    )
  } catch (installError) {
    args.onError(
      installError instanceof Error
        ? installError.message
        : translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.agentsInstallFailed',
            'Could not install agent CLIs on this server.'
          )
    )
  }
}
