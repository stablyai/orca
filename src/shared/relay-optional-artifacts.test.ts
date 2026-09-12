import { describe, expect, it } from 'vitest'
import {
  RELAY_BUN_RUNTIME_FILENAME,
  RELAY_BUN_GLIBC_RUNTIME_FILENAME,
  RELAY_BUN_MUSL_RUNTIME_FILENAME,
  RELAY_WINDOWS_PROCESS_TREE_FILENAME,
  relayBunRuntimeFilename,
  relayArtifactFilenames,
  relayOptionalArtifactFilenames
} from './relay-artifacts'

describe('optional relay artifacts', () => {
  it('keeps the process-table addon out of the required set', () => {
    // The remote install probe requires every name this returns. Demanding an
    // artifact only a Windows build machine can emit would make a correct relay
    // read as MISSING forever and redeploy on every connect.
    expect(relayArtifactFilenames(true)).not.toContain(RELAY_WINDOWS_PROCESS_TREE_FILENAME)
    expect(relayOptionalArtifactFilenames(true)).toContain(RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  })

  it('never offers it to a non-Windows host', () => {
    expect(relayOptionalArtifactFilenames(false)).not.toContain(RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  })

  it('declares the Bun runtime optional for both host families', () => {
    for (const isWindows of [false, true]) {
      expect(relayOptionalArtifactFilenames(isWindows)).toContain(RELAY_BUN_RUNTIME_FILENAME)
    }
  })

  it('filters current Linux packages to both libc-specific runtimes', () => {
    expect(relayOptionalArtifactFilenames('linux-x64')).toEqual([
      RELAY_BUN_GLIBC_RUNTIME_FILENAME,
      RELAY_BUN_MUSL_RUNTIME_FILENAME
    ])
    expect(relayOptionalArtifactFilenames('darwin-arm64')).toContain(RELAY_BUN_RUNTIME_FILENAME)
    expect(relayOptionalArtifactFilenames('darwin-arm64')).not.toContain(
      RELAY_BUN_GLIBC_RUNTIME_FILENAME
    )
  })

  it('maps Bun target names to staged runtime filenames', () => {
    expect(relayBunRuntimeFilename('linux-x64-glibc')).toBe(RELAY_BUN_GLIBC_RUNTIME_FILENAME)
    expect(relayBunRuntimeFilename('linux-arm64-musl')).toBe(RELAY_BUN_MUSL_RUNTIME_FILENAME)
    expect(relayBunRuntimeFilename('win32-x64')).toBe(RELAY_BUN_RUNTIME_FILENAME)
  })

  it('keeps required and optional sets disjoint', () => {
    for (const isWindows of [true, false]) {
      const required = relayArtifactFilenames(isWindows)
      const optional = relayOptionalArtifactFilenames(isWindows)
      expect(optional.filter((name) => required.includes(name))).toEqual([])
    }
  })

  it('still requires everything a relay cannot run without', () => {
    expect(relayArtifactFilenames(true)).toContain('relay.js')
    expect(relayArtifactFilenames(true)).toContain('node-pty-1.1.0-console-list-agent-patch.cjs')
  })

  it('ships the pty-master cloexec patch to every platform', () => {
    // Only Linux runs it, but its bytes are what change the relay content hash, and therefore what
    // moves an upgrading host to a fresh directory whose install can apply it (#17915).
    for (const isWindows of [true, false]) {
      expect(relayArtifactFilenames(isWindows)).toContain('node-pty-1.1.0-master-cloexec-patch.cjs')
    }
  })
})
