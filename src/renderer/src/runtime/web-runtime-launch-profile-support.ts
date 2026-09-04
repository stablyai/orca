import { AGENT_SESSION_LAUNCH_PROFILE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { translate } from '../i18n/i18n'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

/**
 * Why: the legacy terminal create carries a launch profile only as env, so a host that cannot
 * validate the id would launch it unchecked. Refuse on such hosts instead of falling through.
 */
export async function assertWebRuntimeLaunchProfileSupported(
  environmentId: string,
  launchProfileId: string | undefined
): Promise<void> {
  if (!launchProfileId) {
    return
  }
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    AGENT_SESSION_LAUNCH_PROFILE_RUNTIME_CAPABILITY
  )
  if (!supported) {
    throw new Error(
      translate(
        'auto.runtime.webRuntimeSession.launchProfileUnsupported',
        'This Orca host is too old to launch agent profiles. Update the host and try again.'
      )
    )
  }
}
