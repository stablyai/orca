// Resolved xterm appearance the renderer hands to the native terminal, so both draw alike.
export type NativeTerminalTheme = {
  background?: string
  foreground?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export type NativeTerminalAppearance = {
  fontFamily: string
  fontSize: number
  lineHeight: number
  letterSpacing: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  macOptionAsAlt: 'true' | 'false' | 'left' | 'right'
  drawBoldTextInBrightColors: boolean
  minimumContrastRatio: number
  mouseHideWhileTyping: boolean
  copyOnSelect: boolean
  // CSS px between the pane edge and the first cell, matching xterm's container padding.
  paddingX: number
  paddingY: number
  theme: NativeTerminalTheme
}
