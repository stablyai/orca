import { expect, vi } from 'vitest'
import type { RuntimeMobileMarkdownRequest } from '../../../shared/mobile-markdown-document'
import { useAppStore } from '../store'

type WindowStub = {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  api: {
    ui: {
      onMobileMarkdownRequest: (
        callback: (request: RuntimeMobileMarkdownRequest) => void
      ) => () => void
      respondMobileMarkdownRequest: ReturnType<typeof vi.fn>
    }
    fs: {
      readFile: ReturnType<typeof vi.fn>
      writeFile: ReturnType<typeof vi.fn>
    }
  }
}

let mobileMarkdownHandler: ((request: RuntimeMobileMarkdownRequest) => void) | null = null

export function setupWindow({
  readFile,
  writeFile = vi.fn().mockResolvedValue(undefined)
}: {
  readFile: ReturnType<typeof vi.fn>
  writeFile?: ReturnType<typeof vi.fn>
}): { responses: unknown[] } {
  const eventTarget = new EventTarget()
  const responses: unknown[] = []
  mobileMarkdownHandler = null
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      ui: {
        onMobileMarkdownRequest: (callback) => {
          mobileMarkdownHandler = callback
          return () => {
            mobileMarkdownHandler = null
          }
        },
        respondMobileMarkdownRequest: vi.fn((response) => responses.push(response))
      },
      fs: { readFile, writeFile }
    }
  } satisfies WindowStub)
  return { responses }
}

export function resetEditorState(): void {
  useAppStore.setState({
    openFiles: [],
    editorDrafts: {},
    worktreesByRepo: {
      repo: [{ id: 'wt-1', repoId: 'repo', path: '/repo', branch: 'main', hostId: 'local' }]
    },
    repos: [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'repo',
        kind: 'git',
        executionHostId: 'local'
      }
    ]
  } as never)
}

export function openMarkdownFile(): void {
  useAppStore.getState().openFile({
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
}

export async function sendRequest(request: RuntimeMobileMarkdownRequest): Promise<unknown> {
  expect(mobileMarkdownHandler).not.toBeNull()
  mobileMarkdownHandler?.(request)
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = (
      window.api.ui.respondMobileMarkdownRequest as ReturnType<typeof vi.fn>
    ).mock.calls
      .map((call) => call[0])
      .find((candidate) => candidate?.id === request.id)
    if (response) {
      return response
    }
  }
  throw new Error(`No response for ${request.id}`)
}

export function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

export function cleanupMobileMarkdownBridgeHarness(): void {
  vi.unstubAllGlobals()
  mobileMarkdownHandler = null
}
