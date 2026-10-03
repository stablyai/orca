export type RuntimeTerminalRename = {
  handle: string
  tabId: string
  title: string | null
}

export type RuntimeTerminalSetPaneTitle = {
  handle: string
  tabId: string
  leafId: string
  title: string | null
}
