#!/usr/bin/env node
// Repro setup:
//   git clone https://github.com/anomalyco/opencode.git .tmp/opencode
//   node tests/e2e/capture-opencode-tui-repro.mjs
// Then run the captured replay test documented in terminal-foreground-redraw-freeze.spec.ts.

import { createRequire } from 'module'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')

function readOption(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`)
  }
  return value
}

const opencodePackagePath = path.resolve(
  readOption('--opencode-path', path.join(repoRoot, '.tmp', 'opencode', 'packages', 'opencode'))
)
const outputPath = path.resolve(
  readOption('--output', path.join(repoRoot, '.tmp', 'opencode-tui-capture.txt'))
)

if (!existsSync(path.join(opencodePackagePath, 'package.json'))) {
  throw new Error(
    `OpenCode package not found at ${opencodePackagePath}. Clone https://github.com/anomalyco/opencode.git into .tmp/opencode first.`
  )
}

const harnessPath = path.join(opencodePackagePath, 'orca-opencode-tui-repro.tsx')

const harnessSource = String.raw`import { BoxRenderable, createCliRenderer, RGBA, TextRenderable } from "@opentui/core"
import { SpinnerRenderable } from "opentui-spinner"
import { createColors, createFrames } from "./src/cli/cmd/tui/ui/spinner"

const renderer = await createCliRenderer({
  externalOutputMode: "passthrough",
  targetFps: 60,
  gatherStats: false,
  exitOnCtrlC: false,
  useKittyKeyboard: {},
  autoFocus: false,
  openConsoleOnError: false,
  useMouse: false,
})

const root = renderer.root
const ctx = root.ctx
const color = RGBA.fromHex("#ff8a00")
const frames = createFrames({
  color,
  style: "blocks",
  inactiveFactor: 0.6,
  minAlpha: 0.3,
})
const colors = createColors({
  color,
  style: "blocks",
  inactiveFactor: 0.6,
  minAlpha: 0.3,
})

const panel = new BoxRenderable(ctx, {
  width: "100%",
  height: "100%",
  flexDirection: "column",
  paddingLeft: 2,
  paddingTop: 1,
  gap: 1,
})
root.add(panel)

const header = new BoxRenderable(ctx, { flexDirection: "row", gap: 1, height: 1 })
panel.add(header)
header.add(new SpinnerRenderable(ctx, { frames, interval: 40, color: colors }))
header.add(
  new TextRenderable(ctx, {
    content: "OpenCode synthetic active TUI redraw",
    fg: "#ff8a00",
  }),
)

for (let index = 0; index < 28; index++) {
  const row = new BoxRenderable(ctx, { flexDirection: "row", gap: 1, height: 1 })
  panel.add(row)
  row.add(
    new TextRenderable(ctx, {
      content: String(index + 1).padStart(2, "0"),
      fg: index % 2 === 0 ? "#ff8a00" : "#6aa9ff",
      width: 2,
    }),
  )
  row.add(
    new TextRenderable(ctx, {
      content: "#".repeat(36) + " " + "opencode".repeat(10),
      fg: "#e7edf7",
    }),
  )
}

renderer.requestRender()

setTimeout(() => {
  renderer.destroy()
}, 5000)
`

mkdirSync(path.dirname(outputPath), { recursive: true })
writeFileSync(harnessPath, harnessSource)

const out = createWriteStream(outputPath)
const command = process.platform === 'win32' ? 'bun.exe' : 'bun'
const child = pty.spawn(command, ['run', './orca-opencode-tui-repro.tsx'], {
  cwd: opencodePackagePath,
  cols: 120,
  rows: 40,
  name: 'xterm-256color',
  env: {
    ...process.env,
    FORCE_COLOR: '1',
    TERM: 'xterm-256color'
  }
})

child.onData((data) => {
  out.write(data)
})

child.onExit(({ exitCode }) => {
  out.end(() => {
    console.log(`wrote OpenCode/OpenTUI PTY capture to ${outputPath}`)
    process.exitCode = exitCode
  })
})
