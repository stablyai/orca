import React from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultSettings } from '../../../src/shared/constants'
import { parseGitBlamePorcelain } from '../../../src/shared/git-blame-porcelain-parser'
import MonacoEditor from '../../../src/renderer/src/components/editor/MonacoEditor'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { useAppStore } from '../../../src/renderer/src/store'
import type { OpenFile } from '../../../src/renderer/src/store/slices/editor'
import './fixture.css'

type BlameFixtureInput = { filePath: string; relativePath: string; content: string; stdout: string }
type BlameFixtureWindow = Window & {
  __BLAME_FIXTURE__?: BlameFixtureInput
  __BLAME_CALLS__?: { filePath: string; contents?: string }[]
}
const fixtureWindow: BlameFixtureWindow = window

const input = fixtureWindow.__BLAME_FIXTURE__
if (!input) {
  throw new Error('Missing blame fixture input')
}
fixtureWindow.__BLAME_CALLS__ = []
// Why: stands in for main's `git:blame` handler with real porcelain from this checkout.
Object.assign(window, {
  api: {
    git: {
      blame: async (args: { filePath: string; contents?: string }) => {
        fixtureWindow.__BLAME_CALLS__?.push(args)
        return parseGitBlamePorcelain(input.stdout)
      }
    },
    ui: { writeClipboardText: async () => {} }
  }
})

const settings = { ...getDefaultSettings('/disposable-blame-home'), editorGitBlame: true }
const openFiles: OpenFile[] = [
  {
    id: 'blame-file',
    filePath: input.filePath,
    relativePath: input.relativePath,
    worktreeId: 'blame-worktree',
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  }
]
useAppStore.setState({
  settings,
  repos: [],
  worktreesByRepo: {},
  openFiles
})

function Fixture(): React.JSX.Element {
  return (
    <TooltipProvider>
      <main style={{ height: '100vh' }}>
        <MonacoEditor
          fileId="blame-file"
          filePath={input!.filePath}
          viewStateKey="blame-view"
          relativePath={input!.relativePath}
          content={input!.content}
          language="typescript"
          onContentChange={() => {}}
          onSave={() => {}}
          worktreeId="blame-worktree"
          gitBlameSurface
        />
      </main>
    </TooltipProvider>
  )
}
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(<Fixture />)
