# Editor git blame rendered proof

Run `ORCA_BACKGROUND_LAUNCH=1 node tests/tools/editor-git-blame-rendered/run.mjs`.
It renders the production `MonacoEditor` with `editorGitBlame` on in a hidden Electron
window, feeding the `git:blame` bridge real `git blame --porcelain` output for
`src/shared/repo-kind.ts` from this checkout. Evidence lands in
`.bench-fixtures/editor-git-blame-*/`.

Checks:

- Clicking a line shows exactly one inline annotation (more than one means it wrapped).
- Hovering the annotation shows author, email, date, summary, and short hash (DOM text;
  the hidden window paints no frames, so the hover itself is not screenshotted).
- The window stays hidden.

The main-process `git blame` call is covered by `file-blame-real-git.test.ts`.
