import { describe, expect, it, vi } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import type * as HostApi from '../workers/plugin-host-api'
import {
  strictPluginArtifactErrors,
  strictPluginArtifactWarnings
} from './plugin-strict-artifact-checks'

// Why: no released method is deprecated or proposed yet, so two real ones stand in.
vi.mock('../workers/plugin-host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof HostApi>()
  return {
    ...actual,
    getPluginHostMethodSpec: (name: string) => {
      const spec = actual.getPluginHostMethodSpec(name)
      if (name === 'storage.keys') {
        return { ...spec!, deprecatedSince: 9 }
      }
      return name === 'agents.list' ? { ...spec!, proposed: true } : spec
    }
  }
})

function check(engines: string, files: Record<string, string>) {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'host-calls',
    name: 'Host calls',
    version: '1.0.0',
    engines: { orca: engines },
    main: 'dist/main.mjs',
    contributes: { panels: [{ id: 'board', title: 'Board', entry: 'ui/panel.html' }] }
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const read = (path: string) => files[path] ?? null
  return {
    errors: strictPluginArtifactErrors(parsed.manifest, read),
    warnings: strictPluginArtifactWarnings(parsed.manifest, read)
  }
}

describe('host calls in shipped code', () => {
  it('requires engines.orca to cover unguarded calls, per surface', () => {
    const { errors } = check('>=1.4.250', {
      'dist/main.mjs': `
        await orca.host.call('project.list', {})
        if (orca.host.has('workspace.rename')) await orca.host.call('workspace.rename', {})
        await orca.host.call('storage.get', { key: 'a' })`,
      // storage.get reached frames in minor 2 (1.4.246); this floor already covers it.
      'ui/panel.html': `<script type="module">window.orca.host.call("storage.get", {})</script>`
    })
    expect(errors).toEqual([
      `engines.orca: must be at least >=1.4.259, because dist/main.mjs calls host method "project.list", which needs Orca 1.4.259; or guard the call with orca.host.has('project.list')`
    ])
  })

  it('follows imports and script tags to report unknown, proposed and wrong-surface calls', () => {
    const { errors, warnings } = check('>=1.4.259', {
      'dist/main.mjs': `import { run } from './chunks/run.js'\nfn.call('lodash.get')`,
      'dist/chunks/run.js': `
        orca.host.call('workspace.nope')
        orca.host.call('agents.list')
        if (orca.host.has('workspace.later')) orca.host.call('workspace.later')
        orca.host.call('storage.keys')`,
      'ui/panel.html': '<script src="../dist/panel.js"></script>',
      'dist/panel.js': `orca.host.call('terminal.sendText', { terminalId: 't', text: 'x' })`
    })
    expect(errors).toEqual([
      `dist/chunks/run.js: calls host method "workspace.nope", which Orca's Host API 1.10 does not have; it is unreleased or misspelled`,
      'dist/chunks/run.js: calls proposed host method "agents.list"; only development plugins (orca plugin dev) may call it until it is released',
      'dist/panel.js: calls host method "terminal.sendText" from panels, which cannot call it (surfaces: worker)'
    ])
    expect(warnings).toEqual([
      `dist/chunks/run.js: host method "workspace.later" is not in Orca's Host API 1.10; it is unreleased or misspelled, and the orca.host.has('workspace.later') guard skips it here`,
      'deprecated host method storage.keys: called in dist/chunks/run.js; deprecated since Host API 1.9, it keeps working until the next major'
    ])
  })
})
