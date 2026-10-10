import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

type NoticeTestState = Record<string, unknown>

/** Stands in for `@/store`: a real zustand store, so selectors re-render and subscribe fires. */
export const noticeTestStore = createStore<NoticeTestState>()(() => ({}))

export const useAppStore = Object.assign(
  <T>(selector: (state: NoticeTestState) => T): T => useStore(noticeTestStore, selector),
  noticeTestStore
)

const mountedRoots: Root[] = []

export async function mountHook(useHook: () => void): Promise<void> {
  function HookProbe(): null {
    useHook()
    return null
  }
  const root = createRoot(document.createElement('div'))
  mountedRoots.push(root)
  await act(async () => root.render(createElement(HookProbe)))
}

export function unmountHooks(): void {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
}

/** Applies a store write and lets the hook re-render before returning. */
export async function setNoticeState(patch: NoticeTestState): Promise<void> {
  await act(async () => noticeTestStore.setState(patch))
}
