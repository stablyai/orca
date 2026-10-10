/**
 * Publishers whose plugins Orca treats as official: they get the verified
 * badge, may ship bundled with the app, and own the reserved `orca-` id
 * prefix. This list is compiled into the build, so a distribution that ships
 * its own bundled plugins adds its publisher here and changes nothing else.
 */
export type OfficialPluginPublisher = {
  /** Manifest `publisher` slug. */
  publisher: string
  /** GitHub organization whose repositories may publish this publisher's plugins. */
  githubOwner: string
}

export const OFFICIAL_PLUGIN_PUBLISHERS: readonly OfficialPluginPublisher[] = [
  { publisher: 'stablyai', githubOwner: 'stablyai' }
]
