export type BrowserGuestKeyboardFocusRequest = {
  requestId: string
  webContentsId: number
}

export type BrowserGuestKeyboardFocusResponse = {
  requestId: string
  focused: boolean
}
