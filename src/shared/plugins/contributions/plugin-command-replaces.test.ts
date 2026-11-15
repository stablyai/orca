import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
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
    const tasks = { id: 'tasks', title: 'Tasks', replaces: 'view.tasks' }
    const ports = { id: 'ports', title: 'Ports', replaces: 'sidebar.ports.toggle' }
    expect(fingerprint([ports, tasks])).toBe(fingerprint([tasks, ports]))
  })
})
