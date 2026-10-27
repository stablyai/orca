import { createContext } from 'react'

// Why: split panes and hidden worktrees keep editors mounted; only the focused pane answers app commands.
export const EditorCommandOwnerContext = createContext(false)
