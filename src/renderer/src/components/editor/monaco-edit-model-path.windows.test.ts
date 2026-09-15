// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

// Why a dedicated file: monaco reads `process.platform` once at module load, so the Windows URI
// form — the one real users of this crash get — is only reachable by pinning it before the import.
vi.hoisted(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

import { Uri } from 'monaco-editor'
import { isWindows } from 'monaco-editor/esm/vs/base/common/platform.js'
import type { OpenFile } from '@/store/slices/editor'
import { disposeClosedEditorTabs } from './closed-editor-tab-disposal'
import { toMonacoEditModelPath } from './monaco-edit-model-path'
import { createMonacoModelRegistryWithRealUri } from './monaco-model-registry-test-fixture'

const WSL_COLON_PATH =
  '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\notes:2026.md'

describe('toMonacoEditModelPath on Windows', () => {
  it('pins the UNC-aware fallback form monaco builds when the renderer is Windows', () => {
    expect(isWindows).toBe(true)
    expect(toMonacoEditModelPath(Uri, WSL_COLON_PATH)).toBe(
      'file://wsl.localhost/Ubuntu-26.04/home/mj/projects/acp-client/notes%3A2026.md'
    )
  })

  it('keeps the Windows form a stable dispose key', () => {
    const modelPath = toMonacoEditModelPath(Uri, WSL_COLON_PATH)
    const registry = createMonacoModelRegistryWithRealUri([modelPath])

    disposeClosedEditorTabs(registry, [
      { id: 'poisoned', mode: 'edit', filePath: WSL_COLON_PATH } as OpenFile
    ])

    expect(registry.disposed).toEqual([modelPath])
  })
})
