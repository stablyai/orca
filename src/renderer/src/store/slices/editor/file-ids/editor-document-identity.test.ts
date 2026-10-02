import { describe, expect, it } from 'vitest'
import { buildPersistedEditorFileRecords } from '@/lib/workspace-session-editor-records'
import type { OpenFile } from '../types/open-file'
import { editorDocumentIdentityKey } from './editor-document-identity'
import { collectSameDocumentOpenFileIds } from './editor-file-ids'

const WORKTREE_ID = 'repo-1::/workspace'
const FILE_PATH = '/workspace/app.ts'

function openFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  const base: OpenFile = {
    id,
    filePath: FILE_PATH,
    relativePath: 'app.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    isPreview: false,
    runtimeEnvironmentId: null
  }
  return { ...base, ...overrides }
}

const documentVariants: {
  name: string
  left: Partial<OpenFile>
  right: Partial<OpenFile>
  sameDocument: boolean
}[] = [
  { name: 'two records with identical fields', left: {}, right: {}, sameDocument: true },
  {
    name: 'a blank external ssh target beside an absent one',
    left: {},
    right: { externalSshTargetId: '   ' },
    sameDocument: true
  },
  {
    name: 'a blank runtime owner beside a null one',
    left: {},
    right: { runtimeEnvironmentId: '   ' },
    sameDocument: true
  },
  {
    name: 'a null owner beside a runtime owner',
    left: {},
    right: { runtimeEnvironmentId: 'env-a' },
    sameDocument: false
  },
  {
    name: 'a writable record beside a read-only one',
    left: {},
    right: { readOnly: true },
    sameDocument: false
  },
  {
    name: 'a read-only log beside its live-tail twin',
    left: { readOnly: true },
    right: { readOnly: true, liveTail: true },
    sameDocument: false
  },
  {
    name: 'a writable record beside one flagged live-tail',
    left: {},
    right: { liveTail: true },
    sameDocument: true
  },
  {
    name: 'an ssh-pinned record beside a worktree-local one',
    left: {},
    right: { externalSshTargetId: 'ssh-target' },
    sameDocument: false
  },
  {
    name: 'two different paths',
    left: {},
    right: { filePath: '/workspace/other.ts' },
    sameDocument: false
  },
  {
    name: 'two different worktrees',
    left: {},
    right: { worktreeId: 'repo-1::/other' },
    sameDocument: false
  }
]

describe('editor document identity', () => {
  for (const variant of documentVariants) {
    it(`treats ${variant.name} the same way in the key, the session write and the close sweep`, () => {
      const left = openFile('left', variant.left)
      const right = openFile('right', variant.right)

      const sameKey = editorDocumentIdentityKey(left) === editorDocumentIdentityKey(right)
      const { openFilesByWorktree } = buildPersistedEditorFileRecords([left, right], {}, {})
      const sweptIds = collectSameDocumentOpenFileIds([left, right], left)

      expect(sameKey).toBe(variant.sameDocument)
      expect(Object.values(openFilesByWorktree).flat()).toHaveLength(variant.sameDocument ? 1 : 2)
      expect(sweptIds.has(right.id)).toBe(variant.sameDocument)
    })
  }

  it('groups a record under a substituted owner exactly as under its own', () => {
    const file = openFile('left')

    expect(editorDocumentIdentityKey(file, 'env-a')).toBe(
      editorDocumentIdentityKey(openFile('right', { runtimeEnvironmentId: 'env-a' }))
    )
  })
})
