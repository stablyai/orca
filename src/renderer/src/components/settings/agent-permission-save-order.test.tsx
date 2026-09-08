import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { AgentsPane } from './AgentsPane'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { TooltipProvider } from '../ui/tooltip'

const captured = vi.hoisted(() => ({
  row: null as AgentCatalogRowProps | null,
  select: null as ((mode: 'auto' | 'manual' | 'yolo') => void) | null
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude'], refresh: vi.fn() })
}))
vi.mock('./AgentDetectionCatalog', () => ({
  AgentDetectionCatalog: ({
    getRowProps
  }: {
    getRowProps: (agent: (typeof AGENT_CATALOG)[number], detected: boolean) => AgentCatalogRowProps
  }) => {
    captured.row = getRowProps(
      AGENT_CATALOG.find((agent) => agent.id === 'claude')!,
      true
    )
    return null
  }
}))
vi.mock('./AgentPermissionsSetting', () => ({
  AgentPermissionsSetting: ({ onChange }: { onChange: typeof captured.select }) => {
    captured.select = onChange
    return null
  }
}))

beforeEach(() => {
  captured.row = null
  captured.select = null
})

function render(
  settings: GlobalSettings,
  updateSettings: (value: Partial<GlobalSettings>) => Promise<void>
) {
  useAppStore.setState({ settings })
  renderToStaticMarkup(
    <TooltipProvider>
      <AgentsPane settings={settings} updateSettings={updateSettings} />
    </TooltipProvider>
  )
}

it('preserves a custom argument blur while a global Auto click waits for the save', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let settings = getDefaultSettings('test-home')
  const update = vi.fn(async (changes: Partial<GlobalSettings>) => {
    await pending
    settings = { ...settings, ...changes }
    useAppStore.setState({ settings })
  })
  render(settings, update)
  captured.row!.onSaveArgs('--model custom')
  captured.select!('auto')
  release()
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  await Promise.resolve()
  expect(settings.agentDefaultArgs?.claude).toBe('--model custom')
  expect(settings.agentDefaultArgs?.codex).toBe('--approve-for-me')
})

it('shows the effective inherited Yolo preset for sparse settings', () => {
  render({ ...getDefaultSettings('test-home'), agentDefaultArgs: {}, agentDefaultEnv: {} }, vi.fn())
  expect(captured.row?.argsOverride).toBe('--dangerously-skip-permissions')
  expect(captured.row?.permissionMode).toBe('yolo')
})

it('rejects a queued edit after switching the active server, then allows a retry', async () => {
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const settings = getDefaultSettings('test-home')
  const update = vi.fn(async () => {
    await pending
  })
  render(settings, update)
  captured.row?.onSaveArgs('--model custom')
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  captured.select?.('auto')
  useAppStore.setState({ settings: { ...settings, activeRuntimeEnvironmentId: 'other-server' } })
  release()
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('active server changed'))
  )
  expect(update).toHaveBeenCalledTimes(1)
  render(settings, update)
  captured.select?.('manual')
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
})

it('surfaces failed launch saves and lets the next preset retry', async () => {
  const update = vi
    .fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValue(undefined)
  render(getDefaultSettings('test-home'), update)
  captured.select?.('auto')
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('connection lost'))
  )
  captured.select?.('manual')
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
})
