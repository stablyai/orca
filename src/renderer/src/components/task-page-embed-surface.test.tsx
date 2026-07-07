// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  useTaskPageSurface,
  type TaskPageEmbedContext,
  type TaskPageSurface
} from './task-page-embed-surface'

const initialAppState = useAppStore.getInitialState()

const roots: Root[] = []
let latest: TaskPageSurface | null = null

function HookProbe(props: { embed?: TaskPageEmbedContext }): null {
  latest = useTaskPageSurface(props.embed)
  return null
}

async function renderSurface(embed?: TaskPageEmbedContext): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { embed }))
  })
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  latest = null
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
})

const EMBED: TaskPageEmbedContext = { worktreeId: 'repo1::/repo1', lockedRepoId: 'repo1' }

describe('useTaskPageSurface', () => {
  it('seeds embedded pageData with the locked repo preselection', async () => {
    await renderSurface(EMBED)
    expect(latest?.isEmbedded).toBe(true)
    expect(latest?.pageData).toEqual({ preselectedRepoId: 'repo1' })
  })

  // Why: an embedded instance writing to the store would flip activeView to
  // 'tasks' and clobber the global page — the whole point of the surface is
  // that detail open/close cycles in a tab leave the window state untouched.
  it('keeps embedded open/patch/close cycles out of the store', async () => {
    await renderSurface(EMBED)
    const storeTaskPageDataBefore = useAppStore.getState().taskPageData
    const activeViewBefore = useAppStore.getState().activeView

    await act(async () => {
      latest?.openTaskPage({ taskSource: 'github', preselectedRepoId: 'repo1' })
    })
    expect(latest?.pageData.taskSource).toBe('github')

    await act(async () => {
      latest?.patchPageData({ prefilledName: 'draft title' })
    })
    expect(latest?.pageData.prefilledName).toBe('draft title')

    await act(async () => {
      latest?.setTaskResumeState({ githubMode: 'items' })
    })
    expect(latest?.taskResumeState?.githubMode).toBe('items')

    await act(async () => {
      latest?.closeTaskPage()
    })
    expect(latest?.pageData).toEqual({})

    expect(useAppStore.getState().taskPageData).toBe(storeTaskPageDataBefore)
    expect(useAppStore.getState().activeView).toBe(activeViewBefore)
    expect(useAppStore.getState().taskResumeState).toBeUndefined()
  })

  // Why: mirrors the store's replace semantics (ui.ts sets `taskPageData: data`)
  // so detail-open flows behave identically in both modes.
  it('replaces rather than merges embedded pageData on openTaskPage', async () => {
    await renderSurface(EMBED)
    await act(async () => {
      latest?.openTaskPage({ prefilledName: 'first' })
    })
    await act(async () => {
      latest?.openTaskPage({ taskSource: 'linear' })
    })
    expect(latest?.pageData).toEqual({ taskSource: 'linear' })
  })

  it('passes through the store bindings in global mode', async () => {
    await renderSurface(undefined)
    const state = useAppStore.getState()
    expect(latest?.isEmbedded).toBe(false)
    expect(latest?.pageData).toBe(state.taskPageData)
    expect(latest?.openTaskPage).toBe(state.openTaskPage)
    expect(latest?.closeTaskPage).toBe(state.closeTaskPage)
    expect(latest?.setTaskResumeState).toBe(state.setTaskResumeState)
  })

  it('does not re-render embedded instances when the global pageData changes', async () => {
    await renderSurface(EMBED)
    const embeddedPageData = latest?.pageData
    await act(async () => {
      useAppStore.setState({ taskPageData: { prefilledName: 'global change' } })
    })
    expect(latest?.pageData).toBe(embeddedPageData)
  })
})
