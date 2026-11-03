import { describe, expect, it } from 'vitest'
import type { PluginSyntaxMetadata } from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { resolvePluginSyntaxForFile } from './plugin-syntax-packs'

const syntax = (extensions: string[]): PluginSyntaxMetadata => ({
  id: 'plugin:test:syntax',
  pluginKey: 'test',
  label: 'Test',
  extensions,
  filenames: [],
  revision: '1'
})

describe('resolvePluginSyntaxForFile', () => {
  it('lets a plugin color MDX and JSP, which Orca only approximates', () => {
    const entries = [syntax(['.mdx', '.jsp'])]

    expect(resolvePluginSyntaxForFile(entries, '/repo/post.mdx', 'markdown')?.id).toBe(
      'plugin:test:syntax'
    )
    expect(resolvePluginSyntaxForFile(entries, '/repo/index.JSP', 'html')?.id).toBe(
      'plugin:test:syntax'
    )
  })

  it('keeps Orca language for protected files a plugin claims', () => {
    const entries = [syntax(['.md', '.ts'])]

    expect(resolvePluginSyntaxForFile(entries, '/repo/README.md', 'markdown')).toBeNull()
    expect(resolvePluginSyntaxForFile(entries, '/repo/app.ts', 'typescript')).toBeNull()
  })
})
