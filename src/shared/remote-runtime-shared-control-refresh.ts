export function refreshRemoteRuntimeSharedControl(options: {
  intentionallyClosed: boolean
  ready: boolean
  // Why: a wake caller that proved a `ready` socket unresponsive must replace it too.
  force?: boolean
  refresh(): void
}): void {
  if (!options.intentionallyClosed && (options.force || !options.ready)) {
    options.refresh()
  }
}
