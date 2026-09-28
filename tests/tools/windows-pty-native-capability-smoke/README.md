# Packaged Windows PTY native capability smoke

Runs the exact packaged `resources/cli-runtime/bun-runtime.exe` with its hash-verified ConPTY closure. The runner compiles the production `spawnBunPty` implementation into a private temporary directory and copies the packaged gate beside it. Checkout Node supplies target/canary fixture processes; no GUI process is launched and no runtime is downloaded.

A unique 256-bit token binds a target shell, its exited transient WScript launcher, the surviving grandchild, and an unrelated canary to a named pipe. The oracle requires live job membership, exact retained-job termination via public owned-process APIs, PTY/socket exits, and canary survival followed by its separate teardown. It never infers ownership from the process table or accesses private terminal handles.

```text
pnpm run smoke:windows-pty-native-capability -- --exe=dist/win-unpacked/Orca.exe
```

The executable argument selects the package directory; the probe executes its Bun runtime. Package manifest/hash validation occurs before execution. Environment injection options are removed, the ConPTY selector is set before Bun starts, and dotenv/config loading is isolated. A 45-second ceiling reports bounded output and stage breadcrumbs; the production host job owns cleanup when the probe exits.

This qualifies the packaged runtime/provider/gate with freshly compiled production adapter code. It does not prove the packaged daemon bundle contains identical adapter code or test rendered Electron routes. Packages predating Bun are no longer valid negative controls for this gate; mutated evidence tests preserve oracle failure coverage.
