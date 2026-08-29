import { describe, expect, it } from 'vitest'
import { RELAY_WINDOWS_PROCESS_TREE_FILENAME, relayArtifactFilenames } from './relay-artifacts'

describe('Windows relay process-table artifact', () => {
  it('requires the addon on Windows hosts', () => {
    expect(relayArtifactFilenames(true)).toContain(RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  })

  it('never offers the Windows addon to another host', () => {
    expect(relayArtifactFilenames(false)).not.toContain(RELAY_WINDOWS_PROCESS_TREE_FILENAME)
  })

  it('still requires the rest of the Windows runtime', () => {
    expect(relayArtifactFilenames(true)).toContain('relay.js')
    expect(relayArtifactFilenames(true)).toContain('node-pty-1.1.0-console-list-agent-patch.cjs')
  })
})
