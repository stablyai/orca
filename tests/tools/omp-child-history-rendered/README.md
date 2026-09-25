# Child history resume proof

Run `ORCA_BACKGROUND_LAUNCH=1 node tests/tools/omp-child-history-rendered/run.mjs`.
The hidden Electron fixture renders the production virtual history list and styles with
injected OMP, Claude and empty OMP transcripts. It opens eight generations lazily,
resumes the deepest child into a folder target, and checks that Claude remains view-only.
It verifies parent-row measurement avoids overlap, indentation stops growing, scrolling
away/back restores expansion, and collapse removes descendants. CDP screenshots and
native hidden/unfocused window assertions are saved in `.bench-fixtures`.
This exercises production rendering and callbacks, not the complete terminal launch UI.

Run `ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-child-session-resume-smoke.mjs /path/to/oh-my-pi`
for a zero-model-call check against real OMP session storage and CLI parsing. The smoke
builds Orca's path-based resume command, creates parent, child and grandchild transcripts,
and verifies OMP selects each descendant's distinct identity in a folder workspace.
