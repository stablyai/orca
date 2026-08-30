import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Why an enumeration and not a count: the previous note on this reader put its population at 18
 * and said the sites depended on its fail-open behaviour. The real number is 30, and every one
 * of them renders the result to a user, so "these can keep the looser regex" was never a choice
 * anybody had made. A count is easy to be wrong about; this produces the list.
 *
 * `surface` is where the returned string lands. `+classifier` marks the two sites that also
 * match on the string before rendering it — they read a reason, never the envelope, so opening
 * the envelope first is what makes those matches reliable.
 */
const CALL_SITES: Readonly<Record<string, { calls: number; surface: string }>> = {
  'src/renderer/src/components/editor/rich-markdown-image-insert.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/editor/rich-markdown-paste-image.ts': { calls: 1, surface: 'toast' },
  'src/renderer/src/components/editor/useLocalImagePick.ts': { calls: 1, surface: 'toast' },
  'src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx': {
    calls: 2,
    surface: 'toast'
  },
  'src/renderer/src/components/native-chat/native-chat-attachment-upload.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/native-chat/use-native-chat-composer-paste.ts': {
    calls: 1,
    surface: 'composer notice'
  },
  'src/renderer/src/components/right-sidebar/file-explorer-row-file-transfer.ts': {
    calls: 2,
    surface: 'toast'
  },
  'src/renderer/src/components/right-sidebar/useFileDuplicate.ts': { calls: 2, surface: 'toast' },
  'src/renderer/src/components/right-sidebar/useFileExplorerImport.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/right-sidebar/useFileExplorerInlineInput.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/right-sidebar/useFileExplorerMoveDrop.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/settings/McpConfigSection.tsx': {
    calls: 2,
    surface: 'toast and settings banner'
  },
  'src/renderer/src/components/settings/mcp-config-inspection.ts': {
    calls: 2,
    surface: 'config row'
  },
  'src/renderer/src/components/sidebar/AddRepoSteps.tsx': {
    calls: 1,
    surface: 'dialog error+classifier'
  },
  'src/renderer/src/components/sidebar/useAddRepoCloneFlow.ts': {
    calls: 1,
    surface: 'dialog error'
  },
  'src/renderer/src/components/sidebar/useCreateRepo.ts': { calls: 1, surface: 'dialog error' },
  'src/renderer/src/components/terminal-pane/ipc-pty-connect.ts': {
    calls: 1,
    surface: 'terminal error+classifier'
  },
  'src/renderer/src/components/terminal-pane/terminal-native-file-drop.ts': {
    calls: 4,
    surface: 'toast'
  },
  'src/renderer/src/components/terminal-pane/terminal-remote-file-download-open.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/lib/rename-file.ts': { calls: 1, surface: 'toast' },
  'src/renderer/src/store/slices/editor/actions/markdown-preview-actions.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/store/slices/editor/actions/open-file-apply.ts': { calls: 1, surface: 'toast' }
}

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return []
    }
    return [fullPath]
  })
}

// Why: prose about the reader is not a call of it, and test-support modules stub it rather than
// render anything.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Why: the declaration reads as a call to a plain text match, so it is excluded by name rather
// than by regex — a narrower pattern would also drop a real call written across two lines.
const DECLARING_MODULE = 'src/renderer/src/lib/ipc-error.ts'

function countCalls(source: string): number {
  return stripComments(source).match(/\bextractIpcErrorMessage\(/g)?.length ?? 0
}

describe('extractIpcErrorMessage call sites', () => {
  it('are exactly the enumerated ones, at the enumerated counts', () => {
    const found: Record<string, number> = {}
    for (const file of listSourceFiles(join(REPO_ROOT, 'src'))) {
      const name = relative(REPO_ROOT, file).split(sep).join('/')
      if (name === DECLARING_MODULE) {
        continue
      }
      const calls = countCalls(readFileSync(file, 'utf8'))
      if (calls > 0) {
        found[name] = calls
      }
    }

    const expected = Object.fromEntries(
      Object.entries(CALL_SITES).map(([file, { calls }]) => [file, calls])
    )
    expect(found).toEqual(expected)
  })

  // Why: this is the number the freeze note got wrong, so it is asserted rather than described.
  it('number 30, and all of them render to a user', () => {
    const total = Object.values(CALL_SITES).reduce((sum, { calls }) => sum + calls, 0)

    expect(total).toBe(30)
    expect(Object.values(CALL_SITES).filter(({ surface }) => surface === '')).toEqual([])
  })
})
