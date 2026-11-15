import { describe, expect, it, vi } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'
import { satisfiesOrcaEngineRange } from '../manifest/plugin-manifest-engine-range'
import type * as HostApi from '../workers/plugin-host-api'
import { pluginHostCallFindings } from './plugin-host-call-checks'

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
  // Why format 1 below 1.4.245: format 2 itself needs that release.
  const format = satisfiesOrcaEngineRange(engines.slice(2), '>=1.4.245')
    ? {}
    : { manifestVersion: 1, publisher: 'acme', pluginApi: 1 }
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'host-calls',
    name: 'Host calls',
    version: '1.0.0',
    engines: { orca: engines },
    main: 'dist/main.mjs',
    contributes: { panels: [{ id: 'board', title: 'Board', entry: 'ui/panel.html' }] },
    ...format
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return pluginHostCallFindings(parsed.manifest, async (path) =>
    path in files ? { text: files[path]! } : null
  )
}

describe('host calls in shipped code', () => {
  it('requires engines.orca to cover unguarded calls, per surface', async () => {
    const { errors } = await check('>=1.4.250', {
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

  it('follows imports and root-relative scripts to report unknown, proposed and wrong-surface calls', async () => {
    const { errors, warnings } = await check('>=1.4.259', {
      'dist/main.mjs': `import { run } from './chunks/run.js'`,
      'dist/chunks/run.js': `
        orca.host.call('workspace.nope')
        orca.host.call('agents.list')
        orca.host.call('storage.keys')`,
      'ui/panel.html': '<script src="/dist/panel.js"></script>',
      'dist/panel.js': `orca.host.call('terminal.sendText', { terminalId: 't', text: 'x' })`
    })
    expect(errors).toEqual([
      `dist/chunks/run.js: calls host method "workspace.nope", which Orca's Host API 1.10 does not have; it is unreleased or misspelled`,
      'dist/chunks/run.js: calls proposed host method "agents.list"; only development plugins (orca plugin dev) may call it until it is released',
      'dist/panel.js: calls host method "terminal.sendText" from panels, which cannot call it (surfaces: worker)'
    ])
    expect(warnings).toEqual([
      'deprecated host method storage.keys: called in dist/chunks/run.js; deprecated since Host API 1.9, it keeps working until the next major'
    ])
  })

  it('downgrades guarded calls to warnings', async () => {
    const { errors, warnings } = await check('>=1.4.250', {
      'dist/main.mjs': `
        if (orca.api.minor >= 7) await orca.host.call('project.list', {})
        if (orca.host.has('workspace.later')) orca.host.call('workspace.later')
        if (orca.host.has('agents.list')) orca.host.call('agents.list')`,
      'ui/panel.html': `<script>if (orca.host.has('terminal.sendText')) orca.host.call('terminal.sendText', {})</script>`
    })
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      `dist/main.mjs: calls host method "workspace.later", which Orca's Host API 1.10 does not have; it is unreleased or misspelled; the orca.host.has('workspace.later') guard skips it`,
      `dist/main.mjs: calls proposed host method "agents.list"; only development plugins (orca plugin dev) may call it until it is released; the orca.host.has('agents.list') guard skips it`,
      `engines.orca: must be at least >=1.4.259, because dist/main.mjs calls host method "project.list", which needs Orca 1.4.259; or guard the call with orca.host.has('project.list'); taken as guarded by the orca.api.minor check in this plugin`,
      `ui/panel.html: calls host method "terminal.sendText" from panels, which cannot call it (surfaces: worker); the orca.host.has('terminal.sendText') guard skips it`
    ])
  })

  it('keeps guarded calls as errors where engines.orca predates orca.host.has', async () => {
    const { errors } = await check('>=1.4.200', {
      'dist/main.mjs': `if (orca.host.has('workspace.later')) orca.host.call('workspace.later')`,
      'ui/panel.html': `<script>if (orca.host.has('terminal.sendText')) orca.host.call('terminal.sendText', {})</script>`
    })
    expect(errors).toEqual([
      `dist/main.mjs: calls host method "workspace.later", which Orca's Host API 1.10 does not have; it is unreleased or misspelled`,
      'ui/panel.html: calls host method "terminal.sendText" from panels, which cannot call it (surfaces: worker)'
    ])
  })

  it('ignores comments and non-host receivers, but not calls after a URL', async () => {
    const { errors } = await check('>=1.4.259', {
      'dist/main.mjs': `
        // orca.host.call('workspace.commented')
        /* orca.host.call('workspace.blocked') */
        fn.call('workspace.notHost')
        const url = 'https://example.com/a'; orca.host.call('workspace.afterUrl')`,
      'ui/panel.html': '<!-- <script>orca.host.call("workspace.htmlComment")</script> -->'
    })
    expect(errors).toEqual([
      `dist/main.mjs: calls host method "workspace.afterUrl", which Orca's Host API 1.10 does not have; it is unreleased or misspelled`
    ])
  })

  it('warns when a panel page loads no script the check can read', async () => {
    const { warnings } = await check('>=1.4.259', {
      'dist/main.mjs': '',
      'ui/panel.html': '<script src="https://cdn.example.com/app.js"></script>'
    })
    expect(warnings).toEqual([
      'ui/panel.html: loads no script this check could read, so its host calls were not checked'
    ])
  })
})
