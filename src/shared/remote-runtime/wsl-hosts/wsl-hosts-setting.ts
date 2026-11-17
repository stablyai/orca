/** The WSL hosts switch. The key keeps its Experimental-era name so older peers and rollbacks read it. */
export type WslHostsSetting = {
  /** On by default; false is the user's kill switch for new WSL-host work. */
  experimentalWslHosts?: boolean
  /** One-shot guard for the default-on rollout: a saved false from the old
   *  default flips on once; later explicit false sticks. */
  experimentalWslHostsDefaultedOn?: boolean
}

/** Whether the user's WSL hosts setting is on; only an explicit false turns it off. */
export function isWslHostsSettingOn(settings: WslHostsSetting | null | undefined): boolean {
  return !!settings && settings.experimentalWslHosts !== false
}

export function normalizeWslHostsDefaultOn(
  settings: WslHostsSetting | undefined
): Required<WslHostsSetting> {
  return {
    // Every profile persisted the old false default, so pre-rollout false is not an opt-out.
    experimentalWslHosts:
      settings?.experimentalWslHostsDefaultedOn === true
        ? settings.experimentalWslHosts !== false
        : true,
    experimentalWslHostsDefaultedOn: true
  }
}
