import { useAppStore } from '@/store'
import { getRuntimeEnvironmentDisplayName } from '@/store/repos/owner-routing'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY } from '../../../../shared/runtime-file-contracts'

/** The host answered: it has no file there this client may open. Transport failures stay other errors. */
export class HostFileRefusal extends Error {}

/** The host has nothing at the path; older hosts also answer this way for files outside their workspaces. */
export async function hostAbsentRefusal(
  environmentId: string,
  absolutePath: string
): Promise<Error> {
  if (
    await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY,
      15_000
    )
  ) {
    return new HostFileRefusal(`File not found on its host: ${absolutePath}`)
  }
  return new HostFileRefusal(
    translate(
      'components.terminalPane.hostFile.updateHostForOutsideFiles',
      'Update Orca on {{value0}} to open files outside its workspaces',
      { value0: getRuntimeEnvironmentDisplayName(useAppStore.getState(), environmentId) }
    )
  )
}
