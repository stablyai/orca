# OMP transcript rendering proof

From the repository root, choose a disposable output file and run:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-transcript-runtime-smoke.mjs /path/to/read-only/oh-my-pi /tmp/omp-transcript-reader-proof.json
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/omp-transcript-rendered/run.mjs /tmp/omp-transcript-reader-proof.json
```

The first command loads Orca's generated extensions with the actual OMP loader, creates persistent sessions through OMP's SessionManager in disposable directories, receives HTTP metadata, and reads the resulting files with Orca's transcript reader. Its optional third argument exports those exact reader messages. It covers both dedicated and Pi-routed OMP, initial and new sessions, lazy file creation, custom session directories, and child suppression. No model is called.

The second command renders the exported messages using the production desktop message list and styles, checks all four messages are visible, and captures CDP screenshots. It reuses the existing hidden Electron fixture host and writes its disposable profile, screenshots, and report under `.bench-fixtures/omp-transcript-*`. The test asserts all native windows remain hidden and unfocused.

This is a component rendering proof with actual reader output, not a full Orca shell or a live agent conversation. It does not exercise native Windows, WSL, or remote transport at runtime; separate resolver tests cover WSL path authority.
