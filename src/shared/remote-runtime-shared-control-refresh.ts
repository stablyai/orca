export function refreshRemoteRuntimeSharedControl(options: {
  intentionallyClosed: boolean
  ready: boolean
  refresh(): void
}): void {
  if (!options.intentionallyClosed && !options.ready) {
    options.refresh()
  }
}
