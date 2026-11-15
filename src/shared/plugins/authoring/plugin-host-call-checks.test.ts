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

function manifestFor(engines: string) {
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
  return parsed.manifest
}

function check(engines: string, files: Record<string, string>) {
  return pluginHostCallFindings(manifestFor(engines), async (path) =>
    path in files ? { text: files[path]! } : null
  )
}

const unknown = (file: string, name: string) =>
  `${file}: calls host method "${name}", which Orca's Host API 1.10 does not have; it is unreleased or misspelled`

describe('host calls in shipped code', () => {
  it('warns, per surface, about calls newer than engines.orca unless has-guarded', async () => {
    expect(
      await check('>=1.4.250', {
        'dist/main.mjs': `
        await orca.host.call('project.list', {})
        if (orca.host.has('workspace.rename')) await orca.host.call('workspace.rename', {})
        await orca.host.call('storage.get', { key: 'a' })`,
        // storage.get reached frames in minor 2 (1.4.246); this floor already covers it.
        'ui/panel.html': `<script type="module">window.orca.host.call("storage.get", {})</script>`
      })
    ).toEqual({
      errors: [],
      warnings: [
        `engines.orca: must be at least >=1.4.259, because dist/main.mjs calls host method "project.list", which needs Orca 1.4.259; or guard the call with orca.host.has('project.list')`
      ]
    })
  })

  it('fails unknown and proposed calls, and warns about wrong-surface and deprecated ones', async () => {
    expect(
      await check('>=1.4.259', {
        'dist/main.mjs': `import { run } from './chunks/run.js'`,
        'dist/chunks/run.js': `
        orca.host.call('workspace.nope')
        orca.host.call('agents.list')
        orca.host.call('storage.keys')`,
        'ui/panel.html': '<script src="/dist/panel.js"></script>',
        'dist/panel.js': `orca.host.call('terminal.sendText', { terminalId: 't', text: 'x' })`
      })
    ).toEqual({
      errors: [
        unknown('dist/chunks/run.js', 'workspace.nope'),
        'dist/chunks/run.js: calls proposed host method "agents.list"; only development plugins (orca plugin dev) may call it until it is released'
      ],
      warnings: [
        'deprecated host method storage.keys: called in dist/chunks/run.js; deprecated since Host API 1.9, it keeps working until the next major',
        'dist/panel.js: calls host method "terminal.sendText" from panels, which cannot call it (surfaces: worker)'
      ]
    })
  })

  it('downgrades unknown and proposed calls guarded by a literal has, including has?.()', async () => {
    const { errors, warnings } = await check('>=1.4.250', {
      'dist/main.mjs': `
        if (orca.host.has?.('workspace.later')) orca.host.call('workspace.later')
        if (orca.host.has('agents.list')) orca.host.call('agents.list')`
    })
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      `${unknown('dist/main.mjs', 'workspace.later')}; the orca.host.has('workspace.later') guard skips it`,
      `dist/main.mjs: calls proposed host method "agents.list"; only development plugins (orca plugin dev) may call it until it is released; the orca.host.has('agents.list') guard skips it`
    ])
  })

  it('downgrades an unknown call in a plugin that feature-detects at all', async () => {
    const optional = await check('>=1.4.250', {
      'dist/main.mjs': `if (orca.host?.has?.("workspace.future")) orca.host.call("workspace.future")`
    })
    const constant = await check('>=1.4.250', {
      'dist/main.mjs': `const m = 'workspace.future'\nif (orca.host.has(m)) orca.host.call('workspace.future')`
    })
    expect(optional.errors).toEqual([])
    expect(constant).toEqual({
      errors: [],
      warnings: [
        `${unknown('dist/main.mjs', 'workspace.future')}; the plugin calls orca.host.has, which may guard it`
      ]
    })
  })

  it('keeps guarded unknown calls as errors where engines.orca predates orca.host.has', async () => {
    const { errors } = await check('>=1.4.200', {
      'dist/main.mjs': `if (orca.host.has('workspace.later')) orca.host.call('workspace.later')`
    })
    expect(errors).toEqual([unknown('dist/main.mjs', 'workspace.later')])
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
    expect(errors).toEqual([unknown('dist/main.mjs', 'workspace.afterUrl')])
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

  it('stops probing imports that do not exist at the lookup budget', async () => {
    const imports = Array.from({ length: 20_000 }, (_, i) => `import './missing-${i}.js'`)
    const files: Record<string, string> = { 'dist/main.mjs': imports.join('\n') }
    let reads = 0
    const { warnings } = await pluginHostCallFindings(manifestFor('>=1.4.259'), async (path) => {
      reads += 1
      return path in files ? { text: files[path]! } : null
    })
    expect(reads).toBeLessThanOrEqual(512)
    expect(warnings).toContain(
      'host calls were checked in the first 64 files (32 MiB, 512 lookups) the entries load; the rest were not checked'
    )
  })

  it('reads a page full of unclosed script and comment tags in linear time', async () => {
    const page = `${'<script <!-- '.repeat(100_000)}`
    const started = performance.now()
    await check('>=1.4.259', { 'dist/main.mjs': '', 'ui/panel.html': page })
    // Why so loose: a quadratic scan of this page takes tens of seconds; linear takes milliseconds.
    expect(performance.now() - started).toBeLessThan(3000)
  })
})
