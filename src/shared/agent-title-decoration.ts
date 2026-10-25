// Leading status decorations that coding agents prepend to their OSC title —
// Claude's '✳', Gemini's glyphs (✦ ⏲ ◇ ✋), Qoder’s ▲, braille and quarter-circle spinners,
// and Claude's '. '/'* ' working/idle prefixes. Once the tab bar shows the
// provider icon, this leading glyph reads as a redundant second icon, so strip
// it from the displayed title. Scoped to titles we already know belong to an agent.
const LEADING_AGENT_TITLE_DECORATION_RE =
  /^(?:[\u2733\u2726\u23F2\u25C7\u270B\u25B2\u2800-\u28FF\u25D0-\u25D3]+|[.*]\s)\s*/

export function stripLeadingAgentTitleDecorationOrEmpty(title: string): string {
  return title.replace(LEADING_AGENT_TITLE_DECORATION_RE, '').trimStart()
}

export function stripLeadingAgentTitleDecoration(title: string): string {
  const stripped = stripLeadingAgentTitleDecorationOrEmpty(title)
  // Why: never return empty — a title that is *only* a status glyph should keep
  // its original text rather than collapse to a blank tab label.
  return stripped.length > 0 ? stripped : title
}
