// Run under Bun through capture-agent-pty-transcript.mjs; sourceRoot is read-only.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = process.argv[2]
if (!sourceRoot) {
  throw new Error('Expected path to the read-only oh-my-pi checkout')
}
const { buildTerminalTitleWithState } = await import(
  pathToFileURL(resolve(sourceRoot, 'packages/coding-agent/src/utils/title-generator.ts')).href
)
for (const state of ['working', 'idle', 'attention']) {
  for (const label of ['Run a long task', 'release | π : note | OMP ! action required ✦']) {
    // Exercise upstream's explicit Windows argument, independently of the capture host OS.
    const title = buildTerminalTitleWithState(label, state, 0, true, 'win32')
    process.stdout.write(`\x1b]0;${title}\x07`)
  }
}
