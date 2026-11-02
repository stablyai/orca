import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../installation/plugin-host-version'
import { formatPluginApprovalMessage, pluginApprovalGrants } from '../approval/plugin-cli-approval'
import { fingerprintPluginConsent } from '../approval/plugin-consent-fingerprint'

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

describe('approving a replacing plugin from the CLI', () => {
  it('names the replacement among the grants', () => {
    const parsed = parsePluginManifest(
      manifest([{ id: 'tasks', title: 'Task board', replaces: 'view.tasks' }])
    )
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    const grants = pluginApprovalGrants(parsed.manifest)
    expect(grants.replacements).toEqual([{ command: 'Task board', action: 'view.tasks' }])
    const message = formatPluginApprovalMessage({
      pluginKey: 'local.tasks-plus',
      name: 'Tasks plus',
      version: '1.0.0',
      action: 'dev-load',
      approvalFingerprint: 'ap1-x',
      contentIdentity: 'c',
      isDev: true,
      grants,
      why: 'it runs code',
      approveFlag: '--approve ap1-x',
      nextSteps: []
    })
    expect(message).toContain(`- Runs "Task board" instead of Orca's own view.tasks`)
  })

  it('leaves the grants of other plugins as they were', () => {
    const parsed = parsePluginManifest(manifest([{ id: 'tasks', title: 'Tasks' }]))
    expect(parsed.ok && 'replacements' in pluginApprovalGrants(parsed.manifest)).toBe(false)
  })
})

describe('consent for a replacement', () => {
  it('changes when a command starts replacing an action, and only then', () => {
    const fingerprint = (commands: unknown[]) => {
      const parsed = parsePluginManifest(manifest(commands))
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      return fingerprintPluginConsent(parsed.manifest, 'tree')
    }
    const plain = fingerprint([{ id: 'tasks', title: 'Tasks' }])
    const replacing = fingerprint([{ id: 'tasks', title: 'Tasks', replaces: 'view.tasks' }])
    expect(replacing).not.toBe(plain)
    expect(fingerprint([{ id: 'other', title: 'Other' }])).toBe(plain)
  })
})
