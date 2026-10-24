import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from 'zustand'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'

type NoticeTestState = Record<string, unknown>

/** Stands in for `@/store`: a real zustand store, so selectors re-render and subscribe fires. */
const fixture = await createInitialStoreState()
export const noticeTestStore = {
  ...fixture.store,
  setState: (patch: NoticeTestState, replace = false): void => {
    fixture.patch({ ...(replace ? fixture.store.getInitialState() : {}), ...patch })
  }
}

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
