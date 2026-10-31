import * as updatesModule from '../../../../shared/agent-launch-permission-updates'
import * as liftModule from '../../../../shared/tui-agent-permission-lift'
import * as envDraftModule from './agent-default-env-draft'
// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { AgentsPane } from './AgentsPane'
import { persist, runtimeCall } from './__fixtures__/settings-persistence-test-fixture'
import { permissionNotice } from './__fixtures__/permission-notice-test-fixture'
import { TooltipProvider } from '../ui/tooltip'
import {
  measureSettingsWork,
  expectSettingsWorkScale
} from '../../../../shared/global-settings-test-fixture'
import { resolveTuiAgentLaunchArgs } from '../../../../shared/tui-agent-launch-defaults'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'gemini', 'goose'],
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))
vi.mock('./AgentAwakeSetting', () => ({ AgentAwakeSetting: () => null }))
vi.mock('./AgentCacheTimerSection', () => ({ AgentCacheTimerSection: () => null }))

const feedback: (ReturnType<typeof measureSettingsWork>['work'] & { text?: string | null })[] = []
const stringifyFixture = envDraftModule.stringifyAgentDefaultEnvDraft
beforeEach(() => {
  feedback.length = 0
  Object.assign(uiWork, { entries: 0, bytes: 0 })
  envWork.entries = envWork.bytes = 0
  const prepare = updatesModule.wholeAgentEnvironmentUpdates
  vi.spyOn(updatesModule, 'wholeAgentEnvironmentUpdates').mockImplementation((...args) => {
    const [settings, agent, requested] = args
    const size =
      Object.keys(settings.agentDefaultEnv?.[agent] ?? {}).length + Object.keys(requested).length
    const result = measureSettingsWork(() => prepare(...args))
    const entries = result.work.entries + 12 * size
    if (size >= 20) {
      expect(entries).toBeLessThanOrEqual(36 * size + 64)
    }
    envWork.entries += entries
    envWork.bytes += result.work.bytes
    return result.value
  })
  const importer = liftModule.liftAgentPermissionArgs
  vi.spyOn(liftModule, 'liftAgentPermissionArgs').mockImplementation((...args) => {
    const receipt = measureSettingsWork(() => importer(...args))
    feedback.push({ ...receipt.work, text: args[1] })
    return receipt.value
  })
  const parse = envDraftModule.parseAgentDefaultEnvDraft
  vi.spyOn(envDraftModule, 'parseAgentDefaultEnvDraft').mockImplementation((input) => {
    const receipt = measureSettingsWork(() => parse(input))
    // Parse reads/writes each pair; stringify maps and joins each output entry.
    uiWork.entries += receipt.work.entries + 3 * Object.keys(receipt.value.env).length
    uiWork.bytes += receipt.work.bytes + 4 * input.length
    return receipt.value
  })
  const stringify = envDraftModule.stringifyAgentDefaultEnvDraft
  vi.spyOn(envDraftModule, 'stringifyAgentDefaultEnvDraft').mockImplementation((input) => {
    const receipt = measureSettingsWork(() => stringify(input))
    uiWork.entries += receipt.work.entries + 3 * Object.keys(input).length
    uiWork.bytes += receipt.work.bytes + 4 * JSON.stringify(input).length
    return receipt.value
  })
  Object.assign(window.api, { platform: { get: () => ({ platform: 'darwin' }) } })
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings fixture')
  }
  useAppStore.setState({
    settings: { ...settings, agentLaunchChoices: undefined, agentPermissionDefault: 'ask' }
  })
})

function AgentsHarness() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings) {
    throw new Error('Missing settings fixture')
  }
  return (
    <TooltipProvider>
      <AgentsPane
        settings={settings}
        updateSettings={updateSettings}
        hostScope={{ target: { kind: 'local' }, available: true }}
      />
    </TooltipProvider>
  )
}

function argumentsInput(label: string): HTMLTextAreaElement {
  const row = screen.getByText(label, { selector: 'span' }).closest('div.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing agent row')
  }
  const expand = within(row).queryByRole('button', { name: 'Expand agent settings' })
  if (expand) {
    fireEvent.click(expand)
  }
  const input = within(row).getByRole('textbox', { name: 'Arguments' })
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Missing Arguments input')
  }
  return input
}

it.each(
  [20, 200].flatMap((n) => [
    `${'--model opus '.repeat(n)}--dangerously-skip-permissions`,
    `--dangerously-skip-permissions ${'--model opus '.repeat(n).trim()}`
  ])
)('retires the acknowledged recipe %s before chip removal and neutral events', async (recipe) => {
  const models = recipe.replace('--dangerously-skip-permissions', '').trim()
  savedArguments(models, 'full-access')
  render(<AgentsHarness />)
  const input = argumentsInput('Claude')
  expect(screen.getByRole('button', { name: 'Claude permissions' }).getAttribute('data-size')).toBe(
    'xs'
  )
  const remove = () =>
    screen.getByRole('button', { name: /Remove .* and use Claude's own settings/ })
  fireEvent.click(remove())
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  const user = userEvent.setup()
  await user.click(input)
  await user.clear(input)
  fireEvent.change(input, { target: { value: recipe } })
  const before = feedback.length
  await user.keyboard('{Enter}')
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
  expect(persist).toHaveBeenCalledTimes(2)
  const imports = feedback.slice(before)
  expect(imports.map((work) => work.text)).toEqual([recipe, recipe])
  for (const work of imports) {
    expect(work.chars).toBeLessThanOrEqual(36 * recipe.length + 12000)
  }
  const key = recipe.startsWith('--dangerously') ? 'leading' : 'tail',
    total = imports.reduce(
      (sum, work) =>
        sum + work.chars + work.entries + work.visits + work.bytes + 42 * recipe.length,
      0
    )
  expectSettingsWorkScale(`feedback-${key}`, recipe.length > 1000 ? 200 : 20, [total])
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('full-access')
  expect(resolveTuiAgentLaunchArgs('claude', useAppStore.getState().settings ?? {})).toBe(
    `--dangerously-skip-permissions ${models}`
  )
  expect(input.value).toBe(models)
  fireEvent.click(remove())
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(3))
  await user.click(input)
  await user.tab()
  await user.click(input)
  await user.keyboard('{Enter}')
  expect(persist).toHaveBeenCalledTimes(3)
  expect(toast.success).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('own')
  await user.click(input)
  await user.type(input, ' --dangerously-skip-permissions')
  await user.keyboard('{Escape}')
  expect(input.value).toBe(models)
  await user.tab()
  fireEvent.change(input, { target: { value: `  ${models}  ` } })
  fireEvent.blur(input)
  expect(input.value).toBe(models)
  expect(persist).toHaveBeenCalledTimes(3)
})

it.each(['none', '×', 'Backspace'] as const)(
  'keeps dirty Arguments and explicit %s permission removal in order',
  async (removal) => {
    savedArguments('--model sonnet', 'full-access')
    const own = removal === 'Backspace' ? deferredSave() : null
    render(<AgentsHarness />)
    const user = userEvent.setup()
    const input = argumentsInput('Claude')
    const chip = screen.getByRole('button', { name: /Remove .* and use Claude's own settings/ })
    await user.click(input)
    await user.keyboard('{Home}{Shift>}{ArrowRight}{/Shift}{Backspace}')
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '--permission-mode auto --model opus' } })
    input.setSelectionRange(0, 0)
    for (const modifiers of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { repeat: true }
    ]) {
      fireEvent.keyDown(input, { key: 'Backspace', ...modifiers })
      expect(document.activeElement).toBe(input)
    }
    await user.keyboard('{Home}{Backspace}')
    expect(document.activeElement).toBe(chip)
    fireEvent.keyDown(chip, { key: 'Backspace', repeat: true })
    expect(persist).not.toHaveBeenCalled()
    expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('full-access')
    await user.tab()
    expect(document.activeElement).toBe(input)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(chip)
    expect(persist).not.toHaveBeenCalled()
    if (removal === 'none') {
      await user.tab({ shift: true })
      await waitFor(() => expect(input.value).toBe('--model opus'))
      expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('auto')
      expect(toast.success).toHaveBeenCalledTimes(1)
      return
    }
    await (removal === '×' ? user.click(chip) : user.keyboard('{Backspace}'))
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('--model opus')
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    const raw = own ? deferredSave() : null
    const reset = own ? deferredSave() : null
    await user.tab()
    if (own && raw && reset) {
      expect(input.readOnly).toBe(true)
      expect(chip).toHaveProperty('disabled', true)
      const row = input.closest('div.py-3')
      if (!(row instanceof HTMLElement)) {
        throw new Error('Missing row')
      }
      await user.click(within(row).getByRole('button', { name: 'Reset' }))
      await act(async () => own.resolve())
      await waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
      expect(input.value).toBe('--model opus')
      await act(async () => raw.resolve())
      await waitFor(() => expect(persist).toHaveBeenCalledTimes(3))
      await act(async () => reset.reject(new Error('unknown acknowledgement')))
      await waitFor(() => expect(input.readOnly).toBe(false))
      expect(input.value).toBe('--model opus')
      expect(toast.success).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledTimes(1)
      await user.click(within(row).getByRole('button', { name: 'Reset' }))
      await waitFor(() => expect(input.value).toBe(''))
    } else {
      await waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(input.readOnly).toBe(false))
      expect(useAppStore.getState().settings?.agentDefaultArgs?.claude).toBe('--model opus')
    }
    const settings = useAppStore.getState().settings
    expect(settings?.agentPermissionOverrides?.claude).toBe('own')
    expect(resolveTuiAgentLaunchArgs('claude', settings ?? {})).toBe(own ? '' : '--model opus')
    expect(toast.success).not.toHaveBeenCalled()
  }
)

it('retains failed conversion through the ordinary callback and announces only the saved retry', async () => {
  savedArguments('--model opus')
  const save = deferredSave()
  render(<AgentsHarness />)
  const input = argumentsInput('Claude')
  fireEvent.change(input, { target: { value: '--permission-mode auto --model opus' } })
  fireEvent.blur(input)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  act(() => savedArguments(''))
  expect(input.isConnected).toBe(true)
  await act(async () => save.reject(new Error('Settings disk is unavailable')))
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    'Claude settings could not be saved. Try again.'
  )
  expect(toast.success).not.toHaveBeenCalled()
  expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('ask')
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBeUndefined()
  expect(input.value).toBe('--permission-mode auto --model opus')
  fireEvent.blur(input)
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      'Claude set to Approve for me in terminals and new chats.'
    )
  )
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.claude).toBe('auto')
  expect(useAppStore.getState().settings?.agentDefaultArgs?.claude).toBe('--model opus')
  await waitFor(() => expect(input.value).toBe('--model opus'))
  act(() => savedArguments('--later'))
  expect(input.value).toBe('--later')
  fireEvent.change(input, { target: { value: '--dirty' } })
  act(() => savedArguments(''))
  expect(input.value).toBe('--dirty')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input.value).toBe('')
})

it('describes terminal-only conversion without claiming new native chats', async () => {
  render(<AgentsHarness />)
  const input = argumentsInput('Gemini')
  fireEvent.change(input, { target: { value: '--yolo' } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('Gemini set to Full access in terminals.')
  )
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.gemini).toBe('full-access')
  expect(useAppStore.getState().settings?.agentDefaultArgs?.gemini).toBe('')
})

function savedArguments(value: string, choice: 'ask' | 'full-access' = 'ask') {
  useAppStore.setState(({ settings }) => ({
    settings: settings && {
      ...settings,
      agentPermissionDefault: choice,
      agentDefaultArgs: { claude: value }
    }
  }))
}

function savedEnvironment(env: Record<string, string>, agent = 'claude') {
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings fixture')
  }
  useAppStore.setState({
    settings: { ...settings, agentDefaultEnv: { ...settings.agentDefaultEnv, [agent]: env } }
  })
}
function environmentInput(value: string): HTMLInputElement {
  const input = screen.getByDisplayValue(value)
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing Environment input')
  }
  return input
}
function deferredSave() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const done = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  persist.mockImplementationOnce(async (updates) => {
    await done
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Missing settings fixture')
    }
    return { ...settings, ...updates }
  })
  return { resolve, reject }
}

it('retains a whole failed Environment edit across empty publication and retries once', async () => {
  savedEnvironment({ A: 'old', B: 'old' })
  const save = deferredSave()
  render(<AgentsHarness />)
  const input = environmentInput('A=old B=old')
  fireEvent.change(input, { target: { value: 'A=new B=new' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.blur(input)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  expect(persist.mock.calls[0][0].agentDefaultEnv?.claude).toEqual({ A: 'new', B: 'new' })
  act(() => savedEnvironment({}))
  expect(input.isConnected).toBe(true)
  await act(async () => save.reject(new Error('secret provider details')))
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(input.value).toBe('A=new B=new')
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    'Claude settings could not be saved. Try again.'
  )
  expect(toast.success).not.toHaveBeenCalled()
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentDefaultEnv?.claude).toEqual({ A: 'new', B: 'new' })
  )
  expect(persist).toHaveBeenCalledTimes(2)
  act(() => savedEnvironment({ A: 'external' }))
  expect(input.value).toBe('A=external')
  const user = userEvent.setup()
  await user.click(input)
  await user.type(input, 'discard')
  await user.keyboard('{Escape}')
  expect(input.value).toBe('A=external')
  fireEvent.blur(input)
  await waitFor(() => expect(input.readOnly).toBe(false))
  fireEvent.change(input, { target: { value: 'A=two' } })
  fireEvent.change(input, { target: { value: 'A=external' } })
  fireEvent.blur(input)
  act(() => savedEnvironment({ A: 'two' }))
  await user.click(input)
  await user.tab()
  expect(input.value).toBe('A=two')
  expect(persist).toHaveBeenCalledTimes(2)
})

it.each(['blur', 'reset'])('retains ordered Environment work when %s rejects', async (failure) => {
  savedEnvironment({ A: 'old' })
  const blur = deferredSave()
  const reset = deferredSave()
  const user = userEvent.setup()
  render(<AgentsHarness />)
  const input = environmentInput('A=old')
  await user.click(input)
  await user.clear(input)
  await user.type(input, 'A=draft')
  const row = input.closest('div.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing row')
  }
  const resetButton = within(row).getByRole('button', { name: 'Reset' })
  await user.click(resetButton)
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  await act(async () => (failure === 'blur' ? blur.reject(new Error('offline')) : blur.resolve()))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
  expect(input.readOnly).toBe(true)
  expect(input.value).toBe('A=draft')
  await user.click(input)
  await user.tab()
  await user.click(input)
  await user.keyboard('{Enter}')
  expect(persist).toHaveBeenCalledTimes(2)
  if (failure === 'reset') {
    act(() => savedEnvironment({}))
    expect(input.isConnected).toBe(true)
    await act(async () => reset.reject(new Error('offline')))
    await waitFor(() => expect(input.readOnly).toBe(false))
    expect(input.value).toBe('A=draft')
    await user.click(resetButton)
  } else {
    await act(async () => reset.resolve())
  }
  await waitFor(() => expect(input.readOnly).toBe(false))
  expect(input.isConnected).toBe(true)
  expect(input.value).toBe('')
  expect(useAppStore.getState().settings?.agentDefaultEnv?.claude).toEqual({})
  expect(persist).toHaveBeenCalledTimes(2)
  expect(toast.error).toHaveBeenCalledTimes(1)
})

it.each(['darwin', 'win32'].flatMap((platform) => [20, 200].map((n) => [platform, n] as const)))(
  'bounds whole Environment on %s with %i entries',
  async (platform, n) => {
    Object.assign(window.api, { platform: { get: () => ({ platform }) } })
    savedEnvironment({ Path: 'old' })
    savedEnvironment({ TOKEN: 'keep' }, 'gemini')
    const original = useAppStore.getState().settings?.agentDefaultEnv
    render(<AgentsHarness />)
    const input = environmentInput('Path=old')
    const names = Array.from({ length: n }, (_, i) => `K${String(i).padStart(3, '0')}`)
    for (const value of ['new', 'last']) {
      const extra = Object.fromEntries(names.map((k) => [k, value]))
      fireEvent.change(input, {
        target: {
          value: (value === 'new' ? 'Path=old PATH=new ' : 'PATH=new ') + stringifyFixture(extra)
        }
      })
      act(() => savedEnvironment({ TOKEN: 'latest' }, 'gemini'))
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(input.readOnly).toBe(false))
      expect(useAppStore.getState().settings?.agentDefaultEnv).toEqual({
        ...original,
        claude: {
          ...extra,
          ...(platform === 'win32' || value === 'last'
            ? { PATH: 'new' }
            : { Path: 'old', PATH: 'new' })
        },
        gemini: { TOKEN: 'latest' }
      })
    }
    expect(persist).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(updatesModule.wholeAgentEnvironmentUpdates).mock.calls.length
    fireEvent.change(input, { target: { value: `${input.value} ` } })
    fireEvent.blur(input)
    await waitFor(() => expect(input.readOnly).toBe(false))
    expect(persist).toHaveBeenCalledTimes(2)
    expect(updatesModule.wholeAgentEnvironmentUpdates).toHaveBeenCalledTimes(calls + 1)
    const counts = [envWork.entries, envWork.bytes, uiWork.entries, uiWork.bytes]
    expectSettingsWorkScale(`renderer-env-${platform}`, n, counts)
  }
)

it('imports then removes Goose carrier through one whole edit per acknowledgement', async () => {
  savedEnvironment({ OTHER: 'keep' }, 'goose')
  render(<AgentsHarness />)
  const input = environmentInput('OTHER=keep')
  fireEvent.change(input, { target: { value: 'OTHER=next GOOSE_MODE=auto' } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentPermissionOverrides?.goose).toBe('full-access')
  )
  expect(useAppStore.getState().settings?.agentDefaultEnv?.goose).toEqual({ OTHER: 'next' })
  fireEvent.change(input, { target: { value: 'OTHER=last' } })
  fireEvent.blur(input)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentPermissionOverrides?.goose).toBe('own')
  )
  expect(useAppStore.getState().settings?.agentDefaultEnv?.goose).toEqual({ OTHER: 'last' })
  expect(persist).toHaveBeenCalledTimes(2)
})

it.each([20, 200])('keeps Goose Environment editable after Reset/reopen (%i)', async (n) => {
  const extra = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`K${String(i).padStart(3, '0')}`, 'keep'])
  )
  savedEnvironment(
    { goose_mode: 'lowercase-is-distinct', QA_GOOS_KEEP: 'keep', QA_EDITOR_ONE: 'one', ...extra },
    'goose'
  )
  useAppStore.setState(({ settings }) => ({
    settings: settings && {
      ...settings,
      agentPermissionOverrides: { goose: 'own' }
    }
  }))
  render(<AgentsHarness />)
  const input = environmentInput(
    `goose_mode=lowercase-is-distinct QA_GOOS_KEEP=keep QA_EDITOR_ONE=one ${stringifyFixture(extra)}`
  )
  const row = input.closest('div.py-3')
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing Goose row')
  }
  fireEvent.click(within(row).getByRole('button', { name: 'Reset' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(useAppStore.getState().settings?.agentDefaultEnv?.goose).toEqual({}))
  await waitFor(() =>
    expect(within(row).getByPlaceholderText('No default environment')).toHaveProperty('value', '')
  )
  fireEvent.click(within(row).getByRole('button', { name: 'Collapse agent settings' }))
  fireEvent.click(within(row).getByRole('button', { name: 'Expand agent settings' }))
  const empty = within(row).getByPlaceholderText('No default environment')
  fireEvent.change(empty, {
    target: { value: `QA_AFTER_RESET=yes ${stringifyFixture(extra)}` }
  })
  fireEvent.blur(empty)
  await waitFor(() =>
    expect(useAppStore.getState().settings?.agentDefaultEnv?.goose).toEqual({
      QA_AFTER_RESET: 'yes',
      ...extra
    })
  )
  expect(useAppStore.getState().settings?.agentPermissionOverrides?.goose).toBe('own')
  expect(persist).toHaveBeenCalledTimes(2)
  const counts = [envWork.entries, envWork.bytes, uiWork.entries, uiWork.bytes]
  expectSettingsWorkScale('renderer-Reset', n, counts)
})

it('reports one direct local permission action failure without changing saved intent', async () => {
  persist.mockRejectedValueOnce(new Error('private error'))
  render(<AgentsHarness />)
  await pickGlobalPermission('Full access')
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Agent settings could not be saved. Try again.'
    )
  )
  expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('ask')
  expect(toast.success).not.toHaveBeenCalled()
})

const uiWork = { entries: 0, bytes: 0 }
const envWork = { entries: 0, bytes: 0 }

async function pickGlobalPermission(name: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Permissions' }))
  await user.click(await screen.findByRole('menuitemradio', { name: new RegExp(name) }))
}

it.each([false, true])(
  'preserves overflow removals under deferred replies (external update %s)',
  async (external) => {
    useAppStore.setState(({ settings }) => ({
      settings: settings && {
        ...settings,
        agentPermissionOverrides: {
          claude: 'full-access',
          codex: 'full-access',
          cursor: 'full-access',
          grok: 'full-access',
          goose: 'ask'
        }
      }
    }))
    render(<AgentsHarness />)
    await pickGlobalPermission('Ask for approval')
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        '4 agents still use their own permission setting:',
        expect.anything()
      )
    )
    expect(toast.dismiss).not.toHaveBeenCalled()
    const { options, details, follow } = permissionNotice()
    expect(options?.action).toHaveProperty('label', 'Use Ask for approval')
    expect(within(details).getAllByText(/· Full access/)).toHaveLength(3)
    expect(details.textContent).toContain('Codex · Full access')
    expect(details.textContent).toContain('and 1 more')
    const initial = useAppStore.getState().settings
    if (!initial) {
      throw new Error('Missing settings')
    }
    let saved = initial
    const replies: (() => void)[] = []
    window.api.settings.get = vi.fn(async () => saved)
    persist.mockImplementation((updates) => {
      saved = { ...saved, ...updates }
      const reply = saved
      return replies.length < 2
        ? new Promise((resolve) => replies.push(() => resolve(reply)))
        : Promise.resolve(reply)
    })
    const refresh = vi.spyOn(useAppStore.getState(), 'fetchSettings')
    await follow()
    await waitFor(() => expect(replies).toHaveLength(1))
    const unrelated = useAppStore.getState().updateSettings({ machineName: 'Ordinary edit' })
    await waitFor(() => expect(replies).toHaveLength(2))
    try {
      if (external) {
        saved = {
          ...saved,
          agentPermissionOverrides: {
            ...saved.agentPermissionOverrides,
            codex: 'own',
            gemini: 'full-access'
          }
        }
        useAppStore.setState({ settings: saved })
      }
      await act(async () => replies[0]())
      const expected = external
        ? { goose: 'ask', codex: 'own', gemini: 'full-access' }
        : { goose: 'ask' }
      expect(saved.agentPermissionOverrides).toEqual(expected)
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(runtimeCall.mock.calls.map(([request]) => request)).toEqual(
        (external ? ['claude', 'cursor', 'grok'] : ['claude', 'codex', 'cursor', 'grok']).map(
          (agent) => ({
            method: 'settings.mutateAgentLaunch',
            params: { type: 'permission', agent, choice: 'default' }
          })
        )
      )
      await waitFor(() =>
        expect(useAppStore.getState().settings?.agentPermissionOverrides).toEqual(expected)
      )
    } finally {
      await act(async () => {
        replies[1]()
        await unrelated
      })
    }
    expect(useAppStore.getState().settings?.agentPermissionOverrides).toEqual(
      saved.agentPermissionOverrides
    )
    expect(useAppStore.getState().settings).toMatchObject({
      machineName: 'Ordinary edit'
    })
    if (!external) {
      await pickGlobalPermission('Full access')
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2))
      const stale = permissionNotice()
      await pickGlobalPermission('Approve for me')
      await waitFor(() =>
        expect(useAppStore.getState().settings?.agentPermissionDefault).toBe('auto')
      )
      expect(toast.success).toHaveBeenCalledTimes(2)
      const writes = persist.mock.calls.length
      const get = vi.spyOn(window.api.settings, 'get')
      get.mockClear()
      refresh.mockClear()
      runtimeCall.mockClear()
      await stale.follow()
      expect(persist).toHaveBeenCalledTimes(writes)
      expect(get).not.toHaveBeenCalled()
      expect(runtimeCall).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
      expect(useAppStore.getState().settings?.agentPermissionOverrides?.goose).toBe('ask')
      expect(toast.dismiss).toHaveBeenCalled()
    }
  }
)

it('writes local launch choices through the durable RPC as one dirty-text transaction', async () => {
  useAppStore.setState(({ settings }) => ({
    settings: settings && {
      ...settings,
      agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } },
      agentDefaultArgs: { claude: '--verbose' }
    }
  }))
  render(<AgentsHarness />)
  const input = argumentsInput('Claude')
  fireEvent.change(input, { target: { value: '--model sonnet --verbose' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove --model opus' }))
  await waitFor(() => expect(input.value).toBe('--model sonnet --verbose'))
  await waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  expect(runtimeCall.mock.calls[0]?.[0]).toMatchObject({
    method: 'settings.mutateAgentLaunch',
    params: {
      type: 'launch-choices',
      agent: 'claude',
      patch: { model: null },
      userArgs: '--model sonnet --verbose'
    }
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Remove --model opus' })).toBeNull()
  )
  expect(persist).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().settings?.agentLaunchChoices?.claude).toEqual({
    options: { effort: 'high' }
  })
})
