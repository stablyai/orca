// PC-3b: one Orca Cloud agent hold for every launch. Each agent-carrying terminal the desktop asks a
// web host to create goes through createWebRuntimeSessionTerminalResult, which holds it first
// (createWithCloudAgentHold). A new caller of the host's create RPCs would bypass that hold and
// start a not-set-up (or expired) Claude/Codex straight into its own /login, as the create-with-prompt
// pane path and the post-wake relaunch did.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '..', '..')
const HOST_CREATE = /'terminal\.create'|'terminal\.createAgentSession'/

/** Every renderer file allowed to call the host's create RPCs, and why it doesn't bypass the hold. */
const ALLOWED: Record<string, string> = {
  // The choke point: holds an Orca Cloud agent launch before it creates anything.
  'runtime/hosted-terminals/creation/web-runtime-terminal-create-operation.ts': 'the hold itself',
  // A mounted pane's own spawn: the pane spawn gate (cloud-agent-credential-spawn-gate) holds it.
  'components/terminal-pane/pty-transport/remote-runtime/remote-runtime-pty-transport.ts':
    'pane spawn gate',
  // Local runtime only (this computer), never an Orca Cloud host.
  'components/terminal-pane/pty-transport/ipc/ipc-pty-spawn-request.ts': 'local runtime',
  'store/terminals/window-tab-start-in-main.ts': 'local runtime'
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' ? [] : sources(path)
    }
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$|test-fixture\.ts$/.test(name)
      ? [path]
      : []
  })
}

describe('host terminal creates (PC-3b: one hold for every launch)', () => {
  it('only the hold choke point (and gated or local paths) call the host create RPCs', () => {
    const callers = sources(RENDERER)
      .filter((path) => HOST_CREATE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(RENDERER, path))
      .sort()
    expect(callers).toEqual(Object.keys(ALLOWED).sort())
  })

  it('the choke point holds before it creates', () => {
    const source = readFileSync(
      join(RENDERER, 'runtime/hosted-terminals/creation/web-runtime-terminal-create-operation.ts'),
      'utf8'
    )
    expect(source).toMatch(
      /export async function createWebRuntimeSessionTerminalResult[\s\S]*?createWithCloudAgentHold\(/
    )
  })
})
