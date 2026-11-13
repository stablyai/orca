// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isCloud: false,
  paired: false,
  cloudHost: false,
  refresh: vi.fn(async () => {})
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ ephemeralVmRuntimesByWorkspaceId: {}, runtimeEnvironments: [] })
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  useCloudWorkspace: (select: (state: unknown) => unknown) =>
    select({
      ids: new Set(mocks.isCloud ? ['wt'] : []),
      paired: mocks.paired ? { wt: 'env-1' } : {}
    }),
  refreshCloudWorkspaceIds: mocks.refresh
}))
vi.mock('./WorkspaceHostGlyph', () => ({ useIsOrcaCloudHost: () => mocks.cloudHost }))
vi.mock('./CloudWorkspaceMark', () => ({
  CloudWorkspaceMark: () => <span data-live-cloud-mark="" />
}))

const { CloudWorkspaceMarkSlot } = await import('./CloudWorkspaceMarkSlot')

afterEach(() => {
  cleanup()
  mocks.refresh.mockClear()
})

const slot = () =>
  render(
    <CloudWorkspaceMarkSlot
      workspaceId="wt"
      hostId="runtime:env-1"
      fallback={<span data-fallback="server" />}
    />
  )

describe('cloud mark slot (NP-5)', () => {
  it('a new workspace on an Orca Cloud server shows the cloud glyph before its id is listed', () => {
    mocks.isCloud = false
    mocks.cloudHost = true
    const { container } = slot()
    expect(container.querySelector('[data-host-glyph="orca-cloud"]')).not.toBeNull()
    expect(container.querySelector('[data-fallback]')).toBeNull()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('once listed, the live cloud mark', () => {
    mocks.isCloud = true
    mocks.cloudHost = true
    const { container } = slot()
    expect(container.querySelector('[data-live-cloud-mark]')).not.toBeNull()
  })

  it('PAIRED-CHROME: a paired row (created elsewhere) gets the live cloud mark', () => {
    mocks.isCloud = false
    mocks.paired = true
    mocks.cloudHost = true
    const { container } = slot()
    expect(container.querySelector('[data-live-cloud-mark]')).not.toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
    mocks.paired = false
  })

  it('anything else keeps its own glyph', () => {
    mocks.isCloud = false
    mocks.cloudHost = false
    const { container } = slot()
    expect(container.querySelector('[data-fallback="server"]')).not.toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
