// @vitest-environment happy-dom
import { setSessionTestState } from '@/lib/test-support/session-source-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import { useBrowserPageWebviewPartition } from './use-browser-page-webview-partition'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  setSessionTestState(useAppStore, initialState, true)
})

const profile = (id: string, scope: BrowserSessionProfile['scope']): BrowserSessionProfile => ({
  id,
  scope,
  partition: `persist:${id}`,
  label: id,
  source: null
})

it('keeps a tab out of the Default jar once its profile is deleted elsewhere', () => {
  const defaultProfile = profile('default', 'default')
  useAppStore.setState({
    browserSessionProfilesByHostId: { local: [defaultProfile, profile('work', 'isolated')] }
  })
  const { result } = renderHook(() =>
    useBrowserPageWebviewPartition({ sessionProfileId: 'work', sessionPartition: null })
  )
  expect(result.current).toBe('persist:work')

  act(() => useAppStore.setState({ browserSessionProfilesByHostId: { local: [defaultProfile] } }))

  expect(result.current).not.toBe(defaultProfile.partition)
})
