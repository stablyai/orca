import { describe, expect, it } from 'vitest'
import {
  nodePtyEchoStateRequirementViolation,
  REQUIRE_NODE_PTY_ECHO_STATE_ENV_VAR,
  resolveNodePtyEchoStateSupport
} from './node-pty-echo-state-requirement'

// The exports an upstream node-pty prebuild carries — the shape the guard exists to catch.
const PREBUILD_EXPORTS = { fork: () => {}, open: () => {}, resize: () => {}, process: () => {} }
const SOURCE_BUILD_EXPORTS = { ...PREBUILD_EXPORTS, echoState: () => 0 }

describe('node-pty echoState requirement', () => {
  it('accepts a binding that actually exports echoState', () => {
    const lookup = resolveNodePtyEchoStateSupport({ native: SOURCE_BUILD_EXPORTS }, 'darwin')
    expect(lookup.available).toBe(true)
    expect(lookup.nativeExports).toContain('echoState')
  })

  it('rejects an upstream prebuild whose JS patch would still hand back a probe', () => {
    const lookup = resolveNodePtyEchoStateSupport({ native: PREBUILD_EXPORTS }, 'darwin')
    expect(lookup.available).toBe(false)
    expect(lookup.available ? '' : lookup.reason).toContain('fork, open, resize, process')
    // The remedy must name the flag, because plain `pnpm rebuild node-pty` exits 0 on macOS.
    expect(lookup.available ? '' : lookup.reason).toContain('npm_config_build_from_source=true')
  })

  it('rejects a module with no native binding at all', () => {
    expect(resolveNodePtyEchoStateSupport({}, 'linux').available).toBe(false)
    expect(resolveNodePtyEchoStateSupport(undefined, 'linux').available).toBe(false)
  })

  it('fails only when CI demanded the source build', () => {
    const prebuild = resolveNodePtyEchoStateSupport({ native: PREBUILD_EXPORTS }, 'linux')
    const sourceBuild = resolveNodePtyEchoStateSupport({ native: SOURCE_BUILD_EXPORTS }, 'linux')
    expect(nodePtyEchoStateRequirementViolation(prebuild, {})).toBeNull()
    expect(
      nodePtyEchoStateRequirementViolation(prebuild, { [REQUIRE_NODE_PTY_ECHO_STATE_ENV_VAR]: '1' })
    ).toContain('no echoState')
    expect(
      nodePtyEchoStateRequirementViolation(sourceBuild, {
        [REQUIRE_NODE_PTY_ECHO_STATE_ENV_VAR]: '1'
      })
    ).toBeNull()
  })
})
