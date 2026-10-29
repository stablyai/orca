import { describe, expect, it, vi } from 'vitest'
import type { DocPreviewGrantOwner } from '../../../preload/api/doc-preview-api'
import type { OpenFile } from '@/store/slices/editor'
import {
  getShareableBrowserArtifactFile,
  readBrowserHtmlArtifactRequest
} from '@/components/browser-pane/describe-page/browser-artifact-upload'
import { docPreviewGrantFileOwner } from '@/components/browser-pane/workspace-doc/doc-preview-artifact-share'
import { editorArtifactSourceKey } from '@/components/editor/editor-artifact-upload'
import { canonicalArtifactFilePath, fileArtifactSourceKey } from './file-artifact-source-key'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ editorDrafts: {} }) } }))

type Route = {
  executionHostId: 'local' | `runtime:${string}` | `ssh:${string}`
  runtimeEnvironmentId: string | null
}

function editorTab(filePath: string, route: Route | null): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: 'report.html',
    worktreeId: 'repo::/srv/repo',
    language: 'html',
    isDirty: false,
    mode: 'edit',
    runtimeEnvironmentId: route?.runtimeEnvironmentId ?? undefined,
    ...(route
      ? {
          operationProvenance: {
            ownershipProjection: 'explicit',
            generation: {
              route,
              runtimeConnectionGeneration: 1,
              runtimePairingRevision: 1,
              runtimeSshGeneration: null,
              nestedSshGeneration: null,
              directSshGeneration: null
            }
          }
        }
      : {})
  }
}

/** The key a browser tab publishes under, checked against the one its Share button looks up. */
async function browserTabKey(url: string): Promise<string> {
  vi.stubGlobal('window', {
    api: {
      fs: {
        stat: () => Promise.resolve({ size: 1, isDirectory: false }),
        readFile: () => Promise.resolve({ content: '<p>x</p>', isBinary: false })
      }
    }
  })
  const { sourceKey } = await readBrowserHtmlArtifactRequest(url)
  expect(getShareableBrowserArtifactFile(url)?.filePath).toBe(sourceKey)
  return sourceKey
}

function previewKey(owner: DocPreviewGrantOwner, filePath: string): string {
  return fileArtifactSourceKey(docPreviewGrantFileOwner(owner), filePath)
}

const pairedOwner: DocPreviewGrantOwner = {
  kind: 'runtime',
  environmentId: 'server-1',
  worktreeSelector: 'id:repo::/srv/repo',
  worktreeRoot: '/srv/repo'
}
const pairedRoute: Route = { executionHostId: 'runtime:server-1', runtimeEnvironmentId: 'server-1' }
const localRoute: Route = { executionHostId: 'local', runtimeEnvironmentId: null }

describe('file artifact source key', () => {
  it('gives a local file one key from the editor and a browser tab, whatever its slashes', async () => {
    const key = await browserTabKey('file:///C:/repo/report.html')
    expect(key).toBe('C:\\repo\\report.html')
    expect(editorArtifactSourceKey(editorTab('C:/repo/report.html', localRoute))).toBe(key)
    expect(editorArtifactSourceKey(editorTab('C:\\repo\\report.html', localRoute))).toBe(key)
    expect(await browserTabKey('file:///tmp/report.html')).toBe(
      editorArtifactSourceKey(editorTab('/tmp/report.html', localRoute))
    )
  })

  it('gives a paired-server file one key from the editor and the rendered preview', () => {
    const key = editorArtifactSourceKey(editorTab('/srv/repo/report.html', pairedRoute))
    expect(JSON.parse(key)).toEqual([
      'editor',
      'server-1',
      'runtime:server-1',
      '/srv/repo/report.html'
    ])
    expect(previewKey(pairedOwner, '/srv/repo/report.html')).toBe(key)
  })

  it('spells a paired Windows server path one way across surfaces', () => {
    expect(previewKey(pairedOwner, 'C:\\srv\\repo\\report.html')).toBe(
      editorArtifactSourceKey(editorTab('C:/srv/repo/report.html', pairedRoute))
    )
  })

  it('matches the CLI key for SSH files from the editor and the preview', () => {
    const route: Route = { executionHostId: 'ssh:build-box', runtimeEnvironmentId: null }
    const key = editorArtifactSourceKey(editorTab('/home/me/report.html', route))
    expect(JSON.parse(key)).toEqual(['ssh', 'build-box', '/home/me/report.html'])
    expect(previewKey({ kind: 'ssh', connectionId: 'build-box' }, '/home/me/report.html')).toBe(key)
  })

  it('keeps the remote fallback for editor tabs opened before routes were recorded', () => {
    const tab = { ...editorTab('/srv/repo/report.html', null), runtimeEnvironmentId: 'server-1' }
    expect(JSON.parse(editorArtifactSourceKey(tab))).toEqual([
      'editor',
      'server-1',
      'remote',
      '/srv/repo/report.html'
    ])
  })

  it('leaves POSIX paths alone and canonicalizes drive and UNC paths', () => {
    expect(canonicalArtifactFilePath('/srv/repo/a.html')).toBe('/srv/repo/a.html')
    expect(canonicalArtifactFilePath('C:/repo/a.html')).toBe('C:\\repo\\a.html')
    expect(canonicalArtifactFilePath('//server/share/a.html')).toBe('\\\\server\\share\\a.html')
  })
})
