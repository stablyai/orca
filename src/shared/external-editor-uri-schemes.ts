// VS Code (and compatible forks) register these as OS-level deep-link protocols;
// Orca hands them to the OS the same way it does http(s) links.
export const EXTERNAL_EDITOR_URI_SCHEME_NAMES = ['vscode', 'vscode-insiders'] as const

// VS Code's documented file deep link is `vscode://file/<path>[:<line>[:<col>]]`;
// any other authority targets an extension's own URI handler, which issue #31637
// never asked to auto-open. Queries (e.g. `continueOn`, `windowId`) drive editor state, not the file.
export function isExternalEditorFileDeepLink(url: URL): boolean {
  return (
    EXTERNAL_EDITOR_URI_SCHEME_NAMES.some((name) => url.protocol === `${name}:`) &&
    url.hostname === 'file' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.search === '' &&
    url.hash === ''
  )
}

export function isExternalEditorFileDeepLinkHref(href: string): boolean {
  try {
    return isExternalEditorFileDeepLink(new URL(href))
  } catch {
    return false
  }
}
