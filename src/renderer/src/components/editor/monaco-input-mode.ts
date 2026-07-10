// Why: Monaco 0.53+ powers editor input through Chromium's experimental
// EditContext API by default. That path can intermittently stop receiving
// text-update events, leaving every editor unable to accept typed characters
// until the app restarts (an upstream Chromium bug; the terminal is unaffected
// because it uses a plain textarea). Orca keeps editors on the legacy textarea
// input path unless the user explicitly opts into EditContext.
export function resolveEditorEditContextEnabled(experimentalInput: boolean | undefined): boolean {
  return experimentalInput ?? false
}
