import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import { fingerprintPluginConsent } from './plugin-consent-fingerprint'
import {
  PLUGIN_MARKDOWN_RENDERER_LIMIT,
  pluginMarkdownOutputSchema,
  pluginMarkdownRenderRequestSchema,
  pluginMarkdownWorkerResultSchema
} from './plugin-markdown-renderer'

function manifest(renderer: unknown = { language: 'dataview', commandId: 'render-dataview' }) {
  return {
    manifestVersion: 1,
    publisher: 'orca-samples',
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'worker.mjs',
    contributes: {
      commands: [{ id: 'render-dataview', title: 'Render' }],
      markdownRenderers: [renderer]
    }
  }
}

describe('Markdown renderer manifest boundary', () => {
  it('accepts a declared worker renderer and defaults existing plugins to none', () => {
    expect(parsePluginManifest(manifest()).ok).toBe(true)
    const existing = { ...manifest(), contributes: {} }
    expect(parsePluginManifest(existing)).toMatchObject({
      ok: true,
      manifest: { contributes: { markdownRenderers: [] } }
    })
  })

  it.each(['Dataview', 'mermaid', 'eval.js', '', 'x'.repeat(65)])(
    'rejects language %s',
    (language) => {
      expect(parsePluginManifest(manifest({ language, commandId: 'render-dataview' })).ok).toBe(
        false
      )
    }
  )

  it('rejects unknown commands, aliases, duplicates, extra fields and excessive contributions', () => {
    expect(parsePluginManifest(manifest({ language: 'dataview', commandId: 'missing' })).ok).toBe(
      false
    )
    expect(
      parsePluginManifest(
        manifest({ language: 'dataview', commandId: 'render-dataview', html: 'unsafe' })
      ).ok
    ).toBe(false)
    const raw = manifest()
    expect(parsePluginManifest({ ...raw, main: undefined }).ok).toBe(false)
    expect(
      parsePluginManifest({
        ...raw,
        contributes: {
          ...raw.contributes,
          commands: [{ id: 'render-dataview', title: 'Render', action: 'view.toggleTerminal' }]
        }
      }).ok
    ).toBe(false)
    expect(
      parsePluginManifest({
        ...raw,
        contributes: {
          ...raw.contributes,
          markdownRenderers: [
            raw.contributes.markdownRenderers[0],
            raw.contributes.markdownRenderers[0]
          ]
        }
      }).ok
    ).toBe(false)
    expect(
      parsePluginManifest({
        ...raw,
        contributes: {
          ...raw.contributes,
          markdownRenderers: Array.from(
            { length: PLUGIN_MARKDOWN_RENDERER_LIMIT + 1 },
            (_, index) => ({ language: `language-${index}`, commandId: 'render-dataview' })
          )
        }
      }).ok
    ).toBe(false)
  })

  it('requires review for new or changed renderers while preserving existing fingerprints', () => {
    const base = { main: 'worker.mjs', capabilities: [] }
    const first = {
      ...base,
      contributes: {
        markdownRenderers: [
          { language: 'dataview', commandId: 'render' },
          { language: 'query', commandId: 'query' }
        ]
      }
    }
    expect(fingerprintPluginConsent(first)).not.toBe(fingerprintPluginConsent(base))
    expect(fingerprintPluginConsent(first)).toBe(
      fingerprintPluginConsent({
        ...first,
        contributes: { markdownRenderers: first.contributes.markdownRenderers.toReversed() }
      })
    )
    expect(
      fingerprintPluginConsent({
        ...first,
        contributes: { markdownRenderers: [{ language: 'dataview', commandId: 'other' }] }
      })
    ).not.toBe(fingerprintPluginConsent(first))
  })
})

describe('semantic Markdown output', () => {
  it.each([
    {
      kind: 'table',
      columns: ['Note'],
      rows: [[{ text: 'A', reference: { path: 'notes/a.md', base: 'workspace' } }]]
    },
    { kind: 'list', items: [{ text: 'Missing', state: 'missing' }] },
    { kind: 'text', text: '<script>text only</script>' },
    { kind: 'error', message: 'Unsupported query' }
  ])('accepts safe %j', (output) => {
    expect(
      pluginMarkdownWorkerResultSchema.safeParse({ sessionId: 'block', revision: 'r1', output })
        .success
    ).toBe(true)
  })

  it.each([
    '../other.md',
    '/tmp/note.md',
    'https://example.com',
    'C:/notes/a.md',
    'notes\\a.md',
    'notes//a.md',
    'notes/CON.md',
    'notes/a.md\0',
    'program.exe',
    'script.js'
  ])('rejects unsafe reference %s', (path) => {
    expect(
      pluginMarkdownOutputSchema.safeParse({
        kind: 'list',
        items: [{ text: 'A', reference: { path, base: 'workspace' } }]
      }).success
    ).toBe(false)
  })

  it('rejects executable fields, ragged or oversized tables and unknown kinds', () => {
    expect(pluginMarkdownOutputSchema.safeParse({ kind: 'html', html: '<b>A</b>' }).success).toBe(
      false
    )
    expect(
      pluginMarkdownOutputSchema.safeParse({ kind: 'text', text: 'A', html: 'unsafe' }).success
    ).toBe(false)
    expect(
      pluginMarkdownOutputSchema.safeParse({ kind: 'table', columns: ['A'], rows: [[]] }).success
    ).toBe(false)
    expect(
      pluginMarkdownOutputSchema.safeParse({
        kind: 'list',
        items: Array.from({ length: 501 }, () => ({ text: 'A' }))
      }).success
    ).toBe(false)
    expect(
      pluginMarkdownOutputSchema.safeParse({
        kind: 'list',
        items: Array.from({ length: 129 }, () => ({
          text: 'A',
          reference: { path: 'a.md', base: 'document' }
        }))
      }).success
    ).toBe(false)
  })

  it('requires exact source identity and bounds source code', () => {
    const request = {
      language: 'dataview',
      code: 'LIST',
      sessionId: 'block',
      source: {
        runtimeId: 'runtime',
        worktreeId: 'folder:notes',
        fileId: 'file',
        documentPath: '/notes/a.md',
        workspacePath: '/notes'
      }
    }
    expect(pluginMarkdownRenderRequestSchema.safeParse(request).success).toBe(true)
    expect(
      pluginMarkdownRenderRequestSchema.safeParse({
        ...request,
        source: { ...request.source, runtimeId: undefined }
      }).success
    ).toBe(false)
    expect(
      pluginMarkdownRenderRequestSchema.safeParse({ ...request, code: 'x'.repeat(65537) }).success
    ).toBe(false)
  })
})
