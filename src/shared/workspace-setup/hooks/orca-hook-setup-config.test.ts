import { describe, expect, it } from 'vitest'
import { getSetupConfig } from './orca-hook-setup-config'

describe('getSetupConfig', () => {
  it('treats default tab commands as setup-decision commands', () => {
    expect(
      getSetupConfig(undefined, {
        scripts: {},
        defaultTabs: [
          { title: 'Server', command: 'pnpm dev' },
          { title: 'Notes' },
          { command: 'codex' }
        ]
      })
    ).toEqual({
      source: 'yaml',
      kind: 'default-tabs',
      command: '# defaultTabs[1] Server\npnpm dev\n\n# defaultTabs[3]\ncodex'
    })
  })

  it('ignores shared default tab commands when command source is local-only', () => {
    expect(
      getSetupConfig(
        {
          hookSettings: {
            commandSourcePolicy: 'local-only',
            scripts: {}
          }
        },
        {
          scripts: {},
          defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
        }
      )
    ).toBeNull()
  })

  it('keeps the local setup script for run-both repos without shared commands', () => {
    expect(
      getSetupConfig(
        {
          hookSettings: {
            commandSourcePolicy: 'run-both',
            scripts: { setup: 'pnpm install' }
          }
        },
        null
      )
    ).toEqual({ source: 'local', command: 'pnpm install', kind: 'setup' })
  })
})
