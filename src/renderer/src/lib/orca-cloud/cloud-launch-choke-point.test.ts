// PC-3b: every agent launch into a host tab goes through the Orca Cloud hold. Only the hold wrapper
// may call the raw host-tab launcher; a new direct caller would start a not-set-up (or expired)
// Claude/Codex straight into its own /login, as the create-with-prompt and post-wake paths did.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '..', '..')
const RAW =
  /from '@\/lib\/agent-session\/launch\/new-tab\/launch-agent-web-host-tab'|from '\.\/launch-agent-web-host-tab'/
const ALLOWED = new Set([
  'lib/orca-cloud/cloud-web-host-launch-hold.ts',
  'lib/agent-session/launch/new-tab/launch-agent-web-host-tab.ts',
  // The create path (background-declined create terminal): #390 owns its Orca Cloud gate.
  'lib/workspace/creation/worktree-creation-background-mount.ts'
])

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

describe('host-tab agent launches (PC-3b choke point)', () => {
  it('only the Orca Cloud hold wrapper imports the raw host-tab launcher', () => {
    const direct = sources(RENDERER)
      .filter((path) => RAW.test(readFileSync(path, 'utf8')))
      .map((path) => relative(RENDERER, path))
      .filter((path) => !ALLOWED.has(path))
    expect(direct).toEqual([])
  })
})
