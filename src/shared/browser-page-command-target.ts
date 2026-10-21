/** The page a guest-forwarded chrome chord (reload, history, address bar) is aimed at. */
export type BrowserPageCommandTarget = {
  browserPageId: string
}

export type BrowserHistoryNavigateCommand = BrowserPageCommandTarget & {
  direction: 'back' | 'forward'
}
