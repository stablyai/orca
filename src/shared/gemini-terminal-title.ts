import { isQoderTerminalTitle, titleHasAgentName } from './agent-name-token-match'
import { isLegacyPiCompatibleTitle } from './pi-compatible-synthetic-title'

const GEMINI_WORKING = '\u2726' // ✦
const GEMINI_SILENT_WORKING = '\u23F2' // ⏲
const GEMINI_IDLE = '\u25C7' // ◇
const GEMINI_PERMISSION = '\u270B' // ✋

function isPiAgentTitle(title: string): boolean {
  return isLegacyPiCompatibleTitle(title)
}

export function isGeminiTerminalTitle(title: string): boolean {
  if (isQoderTerminalTitle(title)) {
    return false
  }
  // Why: Gemini OSC glyphs are stronger evidence than any cwd/session text.
  if (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE)
  ) {
    return true
  }
  // Why: Pi/OMP titles include cwd/session text; substring matching made
  // paths like "gemini-project" masquerade as Gemini CLI.
  if (isPiAgentTitle(title)) {
    return false
  }
  return titleHasAgentName(title, 'gemini')
}
