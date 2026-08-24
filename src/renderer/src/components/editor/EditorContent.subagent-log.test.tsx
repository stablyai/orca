// @vitest-environment happy-dom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { EditorContent } from './EditorContent'
import type { OpenFile } from '@/store/slices/editor'

const mockState = {
  repos: [],
  worktreesByRepo: {},
  folderWorkspaces: [],
  openConflictReviewFile: vi.fn(),
  openConflictReview: vi.fn(),
  closeFile: vi.fn(),
  setRightSidebarTab: vi.fn(),
  setPendingEditorReveal: vi.fn(),
  reloadOpenCheckRunDetailsTab: vi.fn()
}

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof mockState) => unknown) => selector(mockState)
  useAppStore.getState = () => mockState
  return { useAppStore }
})

describe('EditorContent Subagent Log View Routing', () => {
  const mockSubagentFile: OpenFile = {
    id: 'subagent-file-1',
    filePath: '/Users/johnson/.claude/projects/my-project/subagents/agent-01928374.jsonl',
    relativePath: 'subagents/agent-01928374.jsonl',
    worktreeId: 'wt-1',
    language: 'json',
    isDirty: false,
    mode: 'edit',
    readOnly: true,
    liveTail: true
  }

  const sampleContent = [
    JSON.stringify({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Analyze database schema' }]
      }
    }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'grep_search', input: { Query: 'CREATE TABLE' } }]
      }
    })
  ].join('\n')

  it('renders SubagentTranscriptViewer by default for subagent jsonl paths', () => {
    render(
      <EditorContent
        activeFile={mockSubagentFile}
        viewStateScopeId="subagent-file-1"
        fileContents={{
          'subagent-file-1': { content: sampleContent, isBinary: false, isImage: false }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[mockSubagentFile]}
        worktreeEntries={[]}
        resolvedLanguage="json"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="source"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    expect(screen.getByText('Subagent Transcript')).toBeDefined()
    expect(screen.getByText('Analyze database schema')).toBeDefined()
    expect(screen.getByText(/grep_search/)).toBeDefined()
  })

  it('allows toggling raw JSONL mode', () => {
    render(
      <EditorContent
        activeFile={mockSubagentFile}
        viewStateScopeId="subagent-file-1"
        fileContents={{
          'subagent-file-1': { content: sampleContent, isBinary: false, isImage: false }
        }}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[mockSubagentFile]}
        worktreeEntries={[]}
        resolvedLanguage="json"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="source"
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={vi.fn()}
        handleContentChangeForFile={vi.fn()}
        handleDirtyStateHint={vi.fn()}
        handleSave={vi.fn()}
        handleSaveForFile={vi.fn()}
        reloadContent={vi.fn()}
      />
    )

    const rawBtns = screen.getAllByTitle('Switch to Raw JSONL Monaco Editor')
    expect(rawBtns.length).toBeGreaterThan(0)
    fireEvent.click(rawBtns[0])
  })
})
