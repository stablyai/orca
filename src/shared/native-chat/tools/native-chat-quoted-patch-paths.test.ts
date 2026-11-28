import { expect, it } from 'vitest'
import { editFilesFromPatchText } from './native-chat-edit-patch-files'
import { unifiedPatchSections } from './native-chat-unified-patch'

it('matches decoded Git paths to the changed-file list for multi-file edit cards', () => {
  const patch = String.raw`diff --git "a/\344\270\255.ts" "b/\344\270\255.ts"
--- "a/\344\270\255.ts"
+++ "b/\344\270\255.ts"
@@ -1 +1 @@
-before
+after
diff --git "a/tab\tname.ts" "b/tab\tname.ts"
--- "a/tab\tname.ts"
+++ "b/tab\tname.ts"
@@ -1 +1 @@
-old
+new`

  expect(editFilesFromPatchText(patch, '2 files', true, ['中.ts', 'tab\tname.ts'])).toEqual([
    { path: '中.ts', oldPath: null, changeKind: 'edited', added: 1, removed: 1, truncated: false },
    {
      path: 'tab\tname.ts',
      oldPath: null,
      changeKind: 'edited',
      added: 1,
      removed: 1,
      truncated: false
    }
  ])
})

it('decodes quoted rename-only headers when the other path has unquoted spaces', () => {
  const patch = String.raw`diff --git a/old name.ts "b/new\tname.ts"
similarity index 100%
rename from old name.ts
rename to "new\tname.ts"`

  expect(unifiedPatchSections(patch).sections[0]).toMatchObject({
    path: 'new\tname.ts',
    oldPath: 'old name.ts',
    changeKind: 'renamed'
  })
})
