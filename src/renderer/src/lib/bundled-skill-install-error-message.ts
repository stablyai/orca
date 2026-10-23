import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from './ipc-error'

const homeUnavailable = (): string =>
  translate(
    'auto.lib.bundled.skill.install.error.message.homeUnavailable',
    'Orca could not find the home folder to install the skills into.'
  )

const KNOWN_FAILURE_MESSAGES: ReadonlyMap<string, () => string> = new Map([
  [
    'skill-install-wsl-unavailable',
    () =>
      translate(
        'auto.lib.bundled.skill.install.error.message.wslUnavailable',
        'WSL is not available on this machine, so Orca could not install the skills there.'
      )
  ],
  [
    'skill-install-environment-mismatch',
    () =>
      translate(
        'auto.lib.bundled.skill.install.error.message.environmentMismatch',
        'This machine cannot install skills into WSL.'
      )
  ],
  [
    'skill-install-wsl-provider-detection-failed',
    () =>
      translate(
        'auto.lib.bundled.skill.install.error.message.wslDetectionFailed',
        'Orca could not check which agents are installed in WSL. Make sure the distro starts, then retry.'
      )
  ],
  ['skill-install-wsl-home-unavailable', homeUnavailable],
  ['skill-install-home-unavailable', homeUnavailable]
])

/** Plain copy for a thrown install error; an unknown code still names itself for support. */
export function bundledSkillInstallErrorMessage(error: unknown): string {
  const fallback = translate(
    'auto.lib.bundled.skill.install.error.message.unknown',
    'Orca could not install the skills.'
  )
  const detail = extractIpcErrorMessage(error, fallback)
  const known = KNOWN_FAILURE_MESSAGES.get(detail)
  if (known) {
    return known()
  }
  // Why `bundled-skill-unknown: <name>`: an older host that does not ship a newer skill.
  return /^(?:bundled-)?skill-[a-z0-9-]+(?:: \S+)?$/.test(detail)
    ? `${fallback} (${detail})`
    : detail
}
