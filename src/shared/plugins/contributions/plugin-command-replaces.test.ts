import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../installation/plugin-host-version'

function manifest(commands: unknown[], engines = '>=1.4.248') {
  return {
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'tasks-plus',
    name: 'Tasks plus',
    version: '1.0.0',
    engines: { orca: engines },
    main: 'worker.mjs',
    contributes: { commands }
  }
}

const issues = (raw: unknown): string => {
  const parsed = parsePluginManifest(raw)
  return parsed.ok ? '' : parsed.error
}

describe('commands[].replaces', () => {
  it('takes a built-in action on a worker command, from 1.4.248', () => {
    const parsed = parsePluginManifest(
      manifest([{ id: 'tasks', title: 'Tasks', replaces: 'view.tasks' }])
    )
    expect(parsed.ok && parsed.manifest.contributes.commands[0]?.replaces).toBe('view.tasks')
    expect(
      issues(manifest([{ id: 'tasks', title: 'Tasks', replaces: 'view.tasks' }], '>=1.4.247'))
    ).toContain('1.4.248')
    expect(PLUGIN_SCHEMA_NEWEST_SINCE).toBe('1.4.248')
  })

  it('refuses unknown actions, aliases that replace, and two commands for one action', () => {
    expect(issues(manifest([{ id: 'a', title: 'A', replaces: 'app.quit' }]))).toContain(
      'unknown built-in action: app.quit'
    )
    expect(
      issues(manifest([{ id: 'a', title: 'A', replaces: 'view.tasks', action: 'view.tasks' }]))
    ).toContain('drop action')
    expect(
      issues(
        manifest([
          { id: 'a', title: 'A', replaces: 'view.tasks' },
          { id: 'b', title: 'B', replaces: 'view.tasks' }
        ])
      )
    ).toContain('another command already replaces view.tasks')
  })

  it('needs a worker, since the replacement runs worker code', () => {
    const { main: _main, ...noWorker } = manifest([{ id: 'a', title: 'A', replaces: 'view.tasks' }])
    expect(issues({ ...noWorker, execution: 'declarative' })).not.toBe('')
  })
})
