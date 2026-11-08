import type { RuntimeNavigationTarget } from '../runtime-navigation'

export type RuntimeFileOpenResult = {
  worktree: string
  relativePath: string
  kind: 'markdown' | 'text' | 'binary' | 'image'
  opened: boolean
}

export type RuntimeFileOpenPosition = {
  line: number
  column?: number
}

/** A file main opened itself, which a window shows: layout-owner builds, local window only. */
export type RuntimeEditorFileOpen = {
  worktreeId: string
  filePath: string
  relativePath: string
  runtimeEnvironmentId?: string | null
  navigation?: RuntimeNavigationTarget
  position?: RuntimeFileOpenPosition
}

/** `frameSeq`: the layout stream position whose frame draws the tab. */
export type RuntimeEditorTabReveal = RuntimeEditorFileOpen & { tabId: string; frameSeq?: number }
