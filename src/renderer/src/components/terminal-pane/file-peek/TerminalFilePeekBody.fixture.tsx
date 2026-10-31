import { Copy, Settings } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { FixtureCodeBackdrop } from '../../../component-fixtures/FixtureCodeBackdrop'
import type { TerminalFileContext } from '../terminal-file-path-mapping'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'
import { TerminalFilePeekBody } from './TerminalFilePeekBody'

const WORKTREE_PATH = '/home/dev/orca'
const FILE_CONTEXT: TerminalFileContext = {
  target: { kind: 'local' },
  worktreeId: 'fixture-worktree',
  worktreePath: WORKTREE_PATH,
  sourceHostResolved: true
}

const ARCHITECTURE_IMAGE_PATH = `${WORKTREE_PATH}/docs/assets/architecture.svg`
const ARCHITECTURE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">',
  '<rect width="960" height="540" fill="#e5e5e5"/>',
  '<rect x="80" y="80" width="320" height="140" rx="12" fill="#737373"/>',
  '<rect x="560" y="80" width="320" height="140" rx="12" fill="#a3a3a3"/>',
  '<rect x="320" y="320" width="320" height="140" rx="12" fill="#404040"/>',
  '<path d="M400 150h160M720 220v60l-80 80M240 220v60l80 80" stroke="#262626" stroke-width="6" fill="none"/>',
  '</svg>'
].join('')

const PEEK_PATH = `${WORKTREE_PATH}/src/renderer/src/hooks/use-peek.ts`
const SOURCE_LINES = [
  "import { useEffect, useState } from 'react'",
  "import { readRuntimeFileRange } from '@/runtime/runtime-file-range-client'",
  '',
  "type PeekState = { status: 'idle' } | { status: 'ready'; lines: string[] }",
  '',
  'export function usePeek(path: string): PeekState {',
  "  const [state, setState] = useState<PeekState>({ status: 'idle' })",
  '  useEffect(() => {',
  '    const controller = new AbortController()',
  '    void loadLines(path, controller.signal).then((lines) => {',
  '      if (!controller.signal.aborted) {',
  "        setState({ status: 'ready', lines })",
  '      }',
  '    })',
  '    return () => controller.abort()',
  '  }, [path])',
  '  return state',
  '}',
  '',
  '// Reads stop at the budget, so a huge file never blocks the preview.',
  'const READ_BUDGET_BYTES = 1024 * 1024'
]

const MARKDOWN_SOURCE = [
  '# Terminal file peek',
  '',
  'Hover a path to **preview** it without leaving the terminal. See the [design notes](https://example.com/notes) for details.',
  '',
  '![architecture diagram](https://example.com/architecture.png)',
  '',
  '## Supported previews',
  '',
  '- Source files with the referenced line marked',
  '- Images, up to `10 MiB`',
  '- Markdown, rendered here',
  '',
  '```ts',
  'const peek = await loadTerminalFilePeek(target, signal)',
  '```',
  '',
  '<img src="./docs/screenshot.png" alt="raw html screenshot">',
  '',
  '> Previews are read-only.'
].join('\n')

const DIRECTORY_ENTRIES = [
  ...['docs', 'src', 'scripts', 'tests'].map((name) => ({
    name,
    isDirectory: true,
    isSymlink: false
  })),
  { name: 'node_modules', isDirectory: true, isSymlink: true },
  ...[
    '.gitignore',
    'AGENTS.md',
    'README.md',
    'LICENSE',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'electron.vite.config.ts',
    'oxlint.json',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'vitest.config.ts',
    'playwright.config.ts',
    'knip.json',
    'renovate.json'
  ].map((name) => ({ name, isDirectory: false, isSymlink: name === 'LICENSE' }))
]

// Mirrors LinkActionPopover's surface, path header and action rows so the section is judged in place.
function LinkActionPopoverMock({
  path,
  children
}: {
  path: string
  children: React.ReactNode
}): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  return (
    <div className="relative">
      <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
        <FixtureCodeBackdrop rows={4} />
      </div>
      <div className="relative p-6">
        <div className="w-[min(32rem,calc(100vw-1rem))] min-w-52 rounded-md border border-black/14 bg-floating-surface p-1 text-popover-foreground shadow-floating backdrop-blur-2xl dark:border-white/14">
          <div className="mb-0.5 flex items-center gap-1 overflow-hidden border-b border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            <span className="line-clamp-2 min-w-0 flex-1 break-all">{path}</span>
            <Button size="icon-xs" variant="ghost">
              <Copy className="text-muted-foreground" />
            </Button>
            <Button size="icon-xs" variant="ghost">
              <Settings className="text-muted-foreground" />
            </Button>
          </div>
          {children}
          <div className="flex h-8 items-center gap-1.5 px-1.5 text-[13px]">
            <span className="min-w-0 flex-1 truncate">Open file</span>
            <ShortcutKeyCombo
              keys={[isMac ? '⌘' : 'Ctrl', 'Click']}
              keyCapClassName="min-w-5 px-1 py-0 text-[11px]"
            />
          </div>
          <div className="flex h-8 items-center px-1.5 text-[13px]">Copy file path</div>
        </div>
      </div>
    </div>
  )
}

function popoverFixture(content: TerminalFilePeekContent | 'loading') {
  return defineFixture({
    width: 560,
    render: () => (
      <LinkActionPopoverMock path={content === 'loading' ? PEEK_PATH : content.path}>
        <TerminalFilePeekBody content={content} fileContext={FILE_CONTEXT} />
      </LinkActionPopoverMock>
    )
  })
}

export const loading = popoverFixture('loading')

export const textWithTargetLine = popoverFixture({
  kind: 'text',
  path: PEEK_PATH,
  language: 'typescript',
  firstLineNumber: 38,
  targetLine: 47,
  lines: SOURCE_LINES,
  truncatedLines: false
})

export const textWithoutLine = popoverFixture({
  kind: 'text',
  path: PEEK_PATH,
  language: 'typescript',
  firstLineNumber: 1,
  targetLine: null,
  lines: SOURCE_LINES,
  truncatedLines: false
})

export const textWithTruncatedLines = popoverFixture({
  kind: 'text',
  path: `${WORKTREE_PATH}/dist/bundle.min.js`,
  language: 'javascript',
  firstLineNumber: 1,
  targetLine: 2,
  lines: [
    '"use strict";',
    `var peek=${'function(e){return e.map(function(t){return t.trim()})},'.repeat(5)}0;`,
    'module.exports=peek;'
  ],
  truncatedLines: true
})

export const image = defineFixture({
  width: 560,
  setup() {
    window.api = {
      ...window.api,
      fs: {
        ...window.api.fs,
        readFile: async () => ({
          content: btoa(ARCHITECTURE_SVG),
          isBinary: true,
          isImage: true,
          mimeType: 'image/svg+xml'
        })
      }
    }
  },
  render: () => (
    <LinkActionPopoverMock path={ARCHITECTURE_IMAGE_PATH}>
      <TerminalFilePeekBody
        content={{ kind: 'image', path: ARCHITECTURE_IMAGE_PATH, sizeBytes: 482_113 }}
        fileContext={FILE_CONTEXT}
      />
    </LinkActionPopoverMock>
  )
})

export const markdown = popoverFixture({
  kind: 'markdown',
  path: `${WORKTREE_PATH}/docs/terminal-file-peek.md`,
  source: MARKDOWN_SOURCE
})

export const directoryWithMoreEntries = popoverFixture({
  kind: 'directory',
  path: WORKTREE_PATH,
  entries: DIRECTORY_ENTRIES,
  hasMore: true
})

export const noticeBinary = popoverFixture({
  kind: 'notice',
  path: `${WORKTREE_PATH}/resources/app.icns`,
  reason: 'binary'
})

export const noticeTooLarge = popoverFixture({
  kind: 'notice',
  path: `${WORKTREE_PATH}/logs/trace.log`,
  reason: 'too-large'
})

export const noticeLineOutOfRange = popoverFixture({
  kind: 'notice',
  path: `${WORKTREE_PATH}/src/main/index.ts`,
  reason: 'line-out-of-range'
})

export const noticeUnreadable = popoverFixture({
  kind: 'notice',
  path: `${WORKTREE_PATH}/.env`,
  reason: 'unreadable'
})

export const noticeUnsupported = popoverFixture({
  kind: 'notice',
  path: `${WORKTREE_PATH}/docs/spec.pdf`,
  reason: 'unsupported'
})
