/**
 * `repo.hooksCheck` params: only a launch's `wakeWslDistro` lets a server open a stopped WSL distro
 * (E9). `background` keeps older servers, which wake unless it is set, from opening it for a probe.
 */
export function repoHooksCheckWakeParams(
  background: boolean | undefined
): { background: true } | { wakeWslDistro: true } {
  return background ? { background: true } : { wakeWslDistro: true }
}

/** Server side: a check missing `wakeWslDistro` (older or web clients) never opens the distro. */
export function repoHooksCheckIsBackground(params: {
  background?: boolean
  wakeWslDistro?: boolean
}): boolean {
  return params.wakeWslDistro !== true || params.background === true
}
