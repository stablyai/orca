import { expect, it } from 'vitest'
import { editFilesFromBeginPatch, unwrapBeginPatch } from './native-chat-begin-patch'

it('does not end an apply-patch envelope at a marker inside added file content', () => {
  const patch = `*** Begin Patch
*** Add File: guide.md
+Write the marker:
+*** End Patch
+Then continue.
*** Add File: next.txt
+still here
*** End Patch`
  const unwrapped = unwrapBeginPatch(
    { command: `apply_patch <<'PATCH'\n${patch}\nPATCH` },
    { requireApplyCommand: true }
  )

  expect(unwrapped).toBe(patch)
  expect(
    editFilesFromBeginPatch(unwrapped!).map((file) => ({ path: file.path, added: file.added }))
  ).toEqual([
    { path: 'guide.md', added: 3 },
    { path: 'next.txt', added: 1 }
  ])
})
