import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('remote browser link routing', () => {
  it('pins context-menu opens to the runtime that owns the pane', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./BrowserPane.tsx', import.meta.url)),
      'utf8'
    )
    const paneStart = source.indexOf('function RemoteBrowserPagePane')
    const actionStart = source.indexOf('void openWorkspaceBrowserTab({', paneStart)
    const actionEnd = source.indexOf('}).catch((error) => {', actionStart)
    const openRequest = source.slice(actionStart, actionEnd)

    expect(openRequest).toContain('workspaceId: worktreeId')
    expect(openRequest).toContain('expectedRuntimeEnvironmentId: runtimeEnvironmentId')
  })
})
