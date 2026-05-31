// Leading status decorations that coding agents prepend to their OSC title —
// Claude's '✳', Gemini's glyphs (✦ ⏲ ◇ ✋), braille spinners, and Claude's
// '. '/'* ' working/idle prefixes. Once the tab bar shows the provider icon,
// this leading glyph reads as a redundant second icon, so strip it from the
// displayed title. Scoped to titles we already know belong to an agent.
const LEADING_AGENT_TITLE_DECORATION_RE =
  // eslint-disable-next-line no-control-regex -- intentional unicode status-glyph ranges
  /^(?:[✳✦⏲◇✋⠀-⣿]+|[.*]\s)\s*/

export function stripLeadingAgentTitleDecoration(title: string): string {
  const stripped = title.replace(LEADING_AGENT_TITLE_DECORATION_RE, '').trimStart()
  // Why: never return empty — a title that is *only* a status glyph should keep
  // its original text rather than collapse to a blank tab label.
  return stripped.length > 0 ? stripped : title
}
