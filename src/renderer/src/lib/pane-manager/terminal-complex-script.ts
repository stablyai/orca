// Why: xterm's WebGL renderer draws per-cell glyphs from a texture atlas,
// bypassing the browser shaping/bidi path that the DOM renderer provides.
const COMPLEX_SCRIPT_PATTERN =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u07C0-\u07FF\u0840-\u085F\u0860-\u086F\u0870-\u089F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|\u{10EC0}-\u{10EFF}|\u{1E900}-\u{1E95F}/u

export function terminalOutputRequiresDomRenderer(data: string): boolean {
  return COMPLEX_SCRIPT_PATTERN.test(data)
}
