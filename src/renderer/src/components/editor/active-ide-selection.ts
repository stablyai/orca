// Why: simple module-level holder so MonacoEditor can publish the current
// selection and useClaudeIdeContext can read it without needing a shared store
// slice or React context.
import type { EditorSelection } from './claude-ide-context'

let _current: EditorSelection | null = null

export function setActiveIdeSelection(sel: EditorSelection | null): void {
  _current = sel
}

export function getActiveIdeSelection(): EditorSelection | null {
  return _current
}
