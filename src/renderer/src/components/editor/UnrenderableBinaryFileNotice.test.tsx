import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import UnrenderableBinaryFileNotice from './UnrenderableBinaryFileNotice'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: unknown }) => unknown) => selector({ settings: {} })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => ({})
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

const isLocalPathOpenBlockedMock = vi.fn()
vi.mock('@/lib/local-path-open-guard', () => ({
  isLocalPathOpenBlocked: (...args: unknown[]) => isLocalPathOpenBlockedMock(...args),
  showLocalPathOpenBlockedToast: vi.fn()
}))

describe('UnrenderableBinaryFileNotice', () => {
  it('shows recovery actions for a local file', () => {
    isLocalPathOpenBlockedMock.mockReturnValue(false)
    const html = renderToStaticMarkup(
      <UnrenderableBinaryFileNotice filePath="/tmp/report.docx" worktreeId="wt-1" />
    )
    expect(html).toContain('preview')
    expect(html).toContain('Open with Default App')
  })

  it('hides recovery actions when the path is remote/blocked', () => {
    isLocalPathOpenBlockedMock.mockReturnValue(true)
    const html = renderToStaticMarkup(
      <UnrenderableBinaryFileNotice
        filePath="/home/me/report.docx"
        worktreeId="wt-1"
        runtimeEnvironmentId="ssh-1"
      />
    )
    expect(html).toContain('preview')
    expect(html).not.toContain('Open with Default App')
  })
})
