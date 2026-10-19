// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSshConfigPassiveSyncForTests } from '../../lib/ssh-config-passive-sync'
import type { SshTarget } from '../../../../shared/ssh-types'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SshPane } from './SshPane'

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  toast: vi.fn(),
  recordReadoptions: vi.fn(),
  recordInteraction: vi.fn(),
  requestRemove: vi.fn(),
  openSettingsTarget: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { success: mocks.success, error: vi.fn() })
}))
vi.mock('@/store', () => {
  const state = {
    sshConnectionStates: new Map(),
    recordFeatureInteraction: mocks.recordInteraction,
    setSshTargetsMetadata: vi.fn(),
    clearRemovedSshTargetState: vi.fn(),
    recordSshRepoReadoptions: mocks.recordReadoptions,
    openSettingsTarget: mocks.openSettingsTarget
  }
  return {
    useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('@/ssh/ssh-old-relay-terminals-action', () => ({
  useSshConnectFailureToast: () => vi.fn()
}))
vi.mock('./SshTargetForm', () => ({ SshTargetForm: () => null, EMPTY_FORM: {} }))
vi.mock('./SshTargetDestructiveActions', () => ({
  SshTargetDestructiveActions: ({
    children
  }: {
    children: (actions: {
      busyActionForTarget: () => undefined
      requestRemove: () => void
    }) => ReactNode
  }) => children({ busyActionForTarget: () => undefined, requestRemove: mocks.requestRemove })
}))
vi.mock('./SshTargetServerStatus', () => ({ SshTargetServerStatus: () => null }))
vi.mock('./SshTargetsEmptyState', () => ({ SshTargetsEmptyState: () => null }))

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  Reflect.deleteProperty(window, 'api')
  resetSshConfigPassiveSyncForTests()
  vi.clearAllMocks()
  await setRendererUiLanguage('en')
})

describe('SSH import count notices', () => {
  it.each(['en', 'ko'] as const)(
    'uses complete %s sentences and preserves the no-change branch',
    async (language) => {
      await setRendererUiLanguage(language)
      const importConfig = vi.fn(
        async (): Promise<{ targets: SshTarget[]; repoReadoptions: never[] }> => ({
          targets: [],
          repoReadoptions: []
        })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ssh: { importConfig, listTargets: async () => [] } }
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => {
        root?.render(<SshPane />)
      })
      expect(importConfig).toHaveBeenCalledTimes(1)
      expect(mocks.success).not.toHaveBeenCalled()
      const button = Array.from(container.querySelectorAll('button')).find((entry) =>
        entry.textContent?.includes(language === 'ko' ? '가져오기' : 'Import')
      )
      expect(button).toBeTruthy()
      for (const count of [0, 1, 2]) {
        importConfig.mockResolvedValueOnce({
          targets: Array.from({ length: count }, (_, index) => ({
            id: `fixture-${index}`,
            label: 'Fixture',
            host: 'fixture.example.test',
            port: 22,
            username: 'fixture'
          })),
          repoReadoptions: []
        })
        await act(async () => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
        if (count === 0) {
          expect(mocks.toast).toHaveBeenLastCalledWith('~/.ssh/config already in sync')
          expect(mocks.success).not.toHaveBeenCalled()
        } else {
          expect(mocks.success).toHaveBeenLastCalledWith(
            language === 'ko'
              ? `서버 ${count}개를 동기화했습니다.`
              : `Synced ${count} server${count === 1 ? '' : 's'}`
          )
        }
      }
      expect(importConfig).toHaveBeenCalledTimes(4)
      expect(mocks.recordInteraction).toHaveBeenCalledTimes(3)
    }
  )
})

// #28901: main refuses to remove a managed server's host, which surfaced as a raw IPC error.
describe('removing a managed server host', () => {
  it('points to Managed servers instead of a removal main refuses', async () => {
    const removeTarget = vi.fn()
    const managed: SshTarget = {
      id: 'box',
      label: 'Build box',
      host: 'box.example.test',
      port: 22,
      username: 'dev',
      orcadFence: { environmentId: 'env-box' }
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: {
          importConfig: async () => ({ targets: [], repoReadoptions: [] }),
          listTargets: async () => [managed],
          removeTarget
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <SshPane />
        </TooltipProvider>
      )
    })
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove target"]')
    expect(remove).toBeTruthy()
    await act(async () => {
      remove?.click()
    })
    expect(mocks.requestRemove).not.toHaveBeenCalled()
    expect(removeTarget).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Build box runs a managed Orca server')
    const open = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open Managed servers'
    )
    await act(async () => {
      open?.click()
    })
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'servers',
      repoId: null,
      sectionId: 'managed-servers'
    })
  })
})
