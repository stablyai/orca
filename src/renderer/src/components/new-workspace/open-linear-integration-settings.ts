import { LINEAR_INTEGRATION_SECTION_ID } from '@/components/settings/task-provider-integration-section-ids'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

// Why: reconnect lives on the Integrations Linear card, on the host that owns the read.
export async function openLinearIntegrationSettings({
  sourceContext,
  setActiveRuntimeEnvironmentPreference,
  openSettingsTarget,
  openSettingsPage
}: {
  sourceContext: Pick<TaskSourceContext, 'hostId'> | null | undefined
  setActiveRuntimeEnvironmentPreference: (environmentId: string | null) => Promise<boolean>
  openSettingsTarget: (target: SettingsNavigationTarget) => void
  openSettingsPage: () => void
}): Promise<boolean> {
  // Source row's host. The Active Server field name is a counted focus read.
  const parsed = parseExecutionHostId(sourceContext?.hostId)
  const runtimeEnvironmentId = parsed?.kind === 'runtime' ? parsed.environmentId : null
  const selected = await setActiveRuntimeEnvironmentPreference(runtimeEnvironmentId)
  if (!selected) {
    return false
  }
  openSettingsTarget({
    pane: 'integrations',
    repoId: null,
    sectionId: LINEAR_INTEGRATION_SECTION_ID
  })
  openSettingsPage()
  return true
}
