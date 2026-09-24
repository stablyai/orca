// @vitest-environment happy-dom
import React from 'react'
import { useStore, type StoreApi } from 'zustand'
import * as monaco from 'monaco-editor'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { TerminalController } from '../use-terminal-controller'
import { TerminalLegacyEditorSurface } from '../TerminalLegacyEditorSurface'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { useClosedEditorTabCleanup } from './useClosedEditorTabCleanup'
import {
  createModelLifetimeFixture,
  resetModelLifetimeFixtures
} from './editor-model-lifetime-fixture'

const fixture = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!fixture.store) {
        throw new Error('Missing fixture store')
      }
      return fixture.store.getState()
    },
    subscribe: (...args: Parameters<StoreApi<AppState>['subscribe']>) => {
      if (!fixture.store) {
        throw new Error('Missing fixture store')
      }
      return fixture.store.subscribe(...args)
    }
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('./EditorPanel', () => ({ default: () => <div data-testid="editor-panel" /> }))
let unregister: (() => void) | null = null

function Surface({ visible }: { visible: boolean }): React.JSX.Element | null {
  if (!fixture.store) {
    throw new Error('Missing fixture store')
  }
  const files = useStore(fixture.store, (state) => state.openFiles)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The actual legacy surface reads only these three controller fields.
  const controller = {
    activeTabType: visible ? 'editor' : 'terminal',
    renderedActiveWorktreeId: 'model-fixture::/fixture/workspace',
    worktreeFiles: files
  } as TerminalController
  return <TerminalLegacyEditorSurface controller={controller} />
}

function Shell({ visible = true, generation = 0 }): React.JSX.Element {
  useClosedEditorTabCleanup()
  return <Surface key={generation} visible={visible} />
}

function setup(): ReturnType<typeof createModelLifetimeFixture> {
  const context = createModelLifetimeFixture()
  fixture.store = context.store
  unregister = editorModelRegistry.register(monaco)
  return context
}

afterEach(() => {
  cleanup()
  unregister?.()
  unregister = null
  fixture.store = null
  resetModelLifetimeFixtures()
})

it('keeps the actual cleanup hook alive when closing the final editor unmounts its surface', async () => {
  const { store, add } = setup()
  const view = render(<Shell />)
  for (let index = 0; index < 8; index += 1) {
    const added: { model?: monaco.editor.ITextModel } = {}
    act(() => {
      added.model = add(`shell-last-${index}`).model
    })
    await waitFor(() => expect(view.queryByTestId('editor-panel')).not.toBeNull())
    act(() => store.getState().closeFile(`shell-last-${index}`))
    expect(view.queryByTestId('editor-panel')).toBeNull()
    await Promise.resolve()
    expect(added.model?.isDisposed()).toBe(true)
  }
})

it('observes a close while the terminal subtree is absent and survives its remount', async () => {
  const { store, add } = setup()
  const old = add('shell-hidden')
  const view = render(<Shell />)
  await waitFor(() => expect(view.queryByTestId('editor-panel')).not.toBeNull())
  view.rerender(<Shell visible={false} generation={1} />)
  expect(old.model.isDisposed()).toBe(false)
  act(() => store.getState().closeFile(old.file.id))
  await Promise.resolve()
  expect(old.model.isDisposed()).toBe(true)
  act(() => {
    add('shell-successor')
  })
  view.rerender(<Shell generation={2} />)
  await waitFor(() => expect(view.queryByTestId('editor-panel')).not.toBeNull())
  expect(store.getState().openFiles).toHaveLength(1)
})

it('preserves an open model through ordinary terminal surface switches', async () => {
  const { add } = setup()
  const { model } = add('shell-switch')
  const view = render(<Shell />)
  await waitFor(() => expect(view.queryByTestId('editor-panel')).not.toBeNull())
  view.rerender(<Shell visible={false} />)
  view.rerender(<Shell />)
  await waitFor(() => expect(view.queryByTestId('editor-panel')).not.toBeNull())
  expect(monaco.editor.getModel(model.uri)).toBe(model)
})
