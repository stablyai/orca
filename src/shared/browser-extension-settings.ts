export type BrowserExtensionGlobalSettings = {
  /** Chrome extensions in local browser profiles; switching it applies immediately. On by default. */
  experimentalBrowserExtensions?: boolean
  /** One-shot guard for the default-on rollout: a saved false from the old
   *  default flips on once; a later explicit false sticks. */
  browserExtensionsDefaultedOn?: boolean
}

export function normalizeBrowserExtensionsDefaultOn(
  settings: BrowserExtensionGlobalSettings | undefined
): Required<BrowserExtensionGlobalSettings> {
  return {
    // Pre-rollout false was the old default, not an opt-out.
    experimentalBrowserExtensions:
      settings?.browserExtensionsDefaultedOn === true
        ? settings.experimentalBrowserExtensions !== false
        : true,
    browserExtensionsDefaultedOn: true
  }
}
