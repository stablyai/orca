// @vitest-environment happy-dom
import { mocks, request, detection } from './AgentSessionContinuationDialog.test-fixture'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useNativeChatHandOff } from '../native-chat/use-native-chat-hand-off'
import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'
import * as rpc from '@/runtime/runtime-rpc-subscribe'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'

it('clears failed detection, gates unresolved Start, and submits the displayed root/subfolder choice', async () => {
  const props = { open: true, request, onOpenChange: vi.fn() }
  mocks.detection.mockReturnValue({ ...detection, detectedIds: null, detectionFailed: true })
  const view = render(<AgentSessionContinuationDialog {...props} />, { wrapper: TooltipProvider })
  expect(screen.getByText('Could not detect Agents on this workspace host.')).toBeTruthy()
  mocks.detection.mockReturnValue({ ...detection, detectedIds: null, isLoading: true })
  view.rerender(<AgentSessionContinuationDialog {...props} request={{ ...request }} />)
  expect(screen.queryByText('Could not detect Agents on this workspace host.')).toBeNull()
  expect(screen.getByText('Detecting Agents on this workspace host…')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start New Session' }))
  expect(mocks.launch).not.toHaveBeenCalled()
  mocks.detection.mockReturnValue(detection)
  view.rerender(<AgentSessionContinuationDialog {...props} />)
  fireEvent.click(screen.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('option', { name: /Codex/ }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({
    initialCwd: '/repo/.',
    groupId: 'group-1',
    launchChoice: { route: 'structured-native-chat', requestedSurface: 'chat' }
  })
  fireEvent.click(screen.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('button', { name: 'Start Codex in a terminal' }))
  expect(screen.getAllByRole('combobox')[0].textContent).toContain('Codex (CLI)')
  view.rerender(<AgentSessionContinuationDialog {...props} open={false} />)
  view.rerender(<AgentSessionContinuationDialog {...props} />)
  expect(screen.getAllByRole('combobox')[0].textContent).not.toContain('(CLI)')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch.mock.calls.at(-1)?.[0].launchChoice.requestedSurface).toBeUndefined()
  view.rerender(
    <AgentSessionContinuationDialog
      {...props}
      request={{ ...request, initialCwd: '/repo/packages/app' }}
    />
  )
  expect(screen.getAllByRole('combobox')[0].textContent).toContain('Codex (CLI)')
  fireEvent.click(screen.getAllByRole('combobox')[0])
  expect(screen.getAllByText('No chat in a subfolder').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('option', { name: 'Codex (CLI)' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch.mock.calls.at(-1)?.[0]).toMatchObject({
    initialCwd: '/repo/packages/app',
    launchChoice: { route: 'terminal-tui', requestedSurface: 'terminal' }
  })
})

it.each(['chat', undefined] as const)(
  'labels useful %s fallback without promising older history',
  (sourceKind) => {
    render(
      <AgentSessionContinuationDialog
        open
        request={{ ...request, source: { ...request.source, sourceKind } }}
        onOpenChange={vi.fn()}
      />,
      { wrapper: TooltipProvider }
    )
    expect(
      screen.getByText(
        sourceKind === 'chat'
          ? 'Uses recent messages currently loaded in this chat and the current workspace.'
          : 'Uses captured text and the current workspace.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/reading older transcript details/)).toBeNull()
    expect(screen.getByText('/repo/.')).toBeTruthy()
  }
)

it('keeps the replacement chooser open when an earlier accepted launch completes', async () => {
  const cwd = `/repo/${'long-workspace-directory/'.repeat(12)}project`
  function Chat({ epoch }: { epoch: string }) {
    const handOff = useNativeChatHandOff({
      pane: {
        tabId: 'tab',
        sessionId: 'chat',
        agent: 'codex',
        isVisible: true,
        target: { kind: 'local' }
      },
      directory: { worktreeId: 'wt-1', worktreePath: cwd, runtimeEnvironmentId: null },
      epoch,
      messages: [
        {
          id: '1',
          source: 'transcript',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Saved task' }]
        }
      ],
      focusComposer: () => {}
    })
    return (
      <>
        <button onClick={() => handOff.open()}>Open hand-off</button>
        {handOff.dialog}
      </>
    )
  }
  const capability = Promise.withResolvers<boolean>()
  mocks.capability.mockReturnValueOnce(capability.promise)
  const launchA = Promise.withResolvers<boolean>()
  mocks.launch.mockReturnValueOnce(launchA.promise).mockResolvedValueOnce(true)
  const view = render(<Chat epoch="a" />, { wrapper: TooltipProvider })
  await act(async () => fireEvent.click(screen.getByText('Open hand-off')))
  expect(screen.getByText('Preparing saved chat context…')).toBeTruthy()
  expect(screen.getByText(cwd)).toBeTruthy()
  expect(
    screen.queryByText(/Detecting Agents|Uses captured|recent messages currently loaded/)
  ).toBeNull()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
  ).toBe(true)
  expect(screen.getAllByRole<HTMLButtonElement>('combobox').every((item) => item.disabled)).toBe(
    true
  )
  fireEvent.click(screen.getByText('Cancel'))
  await act(async () => capability.resolve(false))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => fireEvent.click(screen.getByText('Open hand-off')))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch).toHaveBeenCalledOnce()
  view.rerender(<Chat epoch="b" />)
  await act(async () => fireEvent.click(screen.getByText('Open hand-off')))
  await act(async () => launchA.resolve(true))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
  ).toBe(false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([
  ['claude', true],
  ['claude-agent-teams', true],
  ['claude', false]
] as const)(
  'renders destination rows from %s with family exclusion=%s and starts the clicked agent',
  async (sourceAgent, avoidSourceAgent) => {
    const available: TuiAgent[] = ['claude', 'claude-agent-teams', 'codex', 'gemini']
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        defaultTuiAgent: 'codex',
        disabledTuiAgents: getAgentCatalog()
          .filter((agent) => !available.includes(agent.id))
          .map((agent) => agent.id)
      }
    })
    mocks.detection.mockReturnValue({ ...detection, detectedIds: null, isLoading: true })
    const props = {
      open: true,
      request: { ...request, source: { ...request.source, sourceAgent }, avoidSourceAgent },
      onOpenChange: vi.fn()
    }
    const view = render(<AgentSessionContinuationDialog {...props} />, { wrapper: TooltipProvider })
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
    ).toBe(true)
    mocks.detection.mockReturnValue({ ...detection, detectedIds: available })
    view.rerender(<AgentSessionContinuationDialog {...props} />)
    fireEvent.click(screen.getAllByRole('combobox')[0])
    expect(screen.queryAllByRole('option', { name: /Claude/ }).length === 0).toBe(avoidSourceAgent)
    expect(screen.queryByRole('button', { name: 'Start Claude in a terminal' }) === null).toBe(
      avoidSourceAgent
    )
    const search = screen.getByPlaceholderText('Search agents...')
    fireEvent.change(search, { target: { value: 'Claude' } })
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    expect(screen.queryAllByRole('option', { name: /Claude/ }).length === 0).toBe(avoidSourceAgent)
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('option', { name: 'Gemini (CLI)' }))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Start New Session' }))
    )
    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent: 'gemini',
        launchChoice: expect.objectContaining({ requestedSurface: 'terminal' })
      })
    )
  }
)

it.each([
  ['codex', true, false],
  ['claude', true, true],
  ['claude-agent-teams', true, false],
  ['claude', true, false],
  ['claude', false, false]
] as const)(
  'hands off from %s with family exclusion=%s and alternative=%s',
  async (sourceAgent, avoidSourceAgent, hasAlternative) => {
    const available: TuiAgent[] = hasAlternative
      ? ['claude', 'claude-agent-teams', 'codex']
      : sourceAgent === 'codex'
        ? ['codex']
        : ['claude', 'claude-agent-teams']
    const settings = useAppStore.getState().settings!
    useAppStore.setState({
      settings: {
        ...settings,
        defaultTuiAgent: sourceAgent,
        disabledTuiAgents: getAgentCatalog()
          .filter((agent) => !available.includes(agent.id))
          .map((agent) => agent.id)
      }
    })
    mocks.detection.mockReturnValue({ ...detection, detectedIds: available })
    render(
      <AgentSessionContinuationDialog
        open
        request={{ ...request, source: { ...request.source, sourceAgent }, avoidSourceAgent }}
        onOpenChange={vi.fn()}
      />,
      { wrapper: TooltipProvider }
    )
    const selected = avoidSourceAgent ? (hasAlternative ? 'codex' : null) : sourceAgent
    const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' })
    expect(start.disabled).toBe(selected === null)
    if (selected === null) {
      expect(
        screen.getByText(
          `Only Agents sharing the usage limit with ${getAgentLabel(sourceAgent)} are available on this workspace host. Enable or install a different Agent.`
        )
      ).toBeTruthy()
      expect(
        screen.queryByText('No enabled Agents were detected on this workspace host.')
      ).toBeNull()
    }
    const picker = screen.getAllByRole('combobox')[0]
    fireEvent.click(picker)
    const familyRows = screen.queryAllByRole('option', {
      name: sourceAgent === 'codex' ? /Codex/ : /Claude/
    })
    expect(familyRows.length === 0).toBe(avoidSourceAgent)
    fireEvent.click(picker)
    await act(async () => fireEvent.click(start))
    if (selected) {
      expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ agent: selected }))
    } else {
      expect(mocks.launch).not.toHaveBeenCalled()
    }
  }
)

it('retires the old pick when source and launch context change before Start', async () => {
  mocks.detection.mockReturnValue({
    ...detection,
    detectedIds: ['claude', 'claude-agent-teams', 'codex', 'gemini']
  })
  const props = {
    open: true,
    request: {
      ...request,
      source: { ...request.source, sourceAgent: 'claude' as const },
      avoidSourceAgent: true
    },
    onOpenChange: vi.fn()
  }
  const view = render(<AgentSessionContinuationDialog {...props} />, { wrapper: TooltipProvider })
  fireEvent.click(screen.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('option', { name: 'Gemini (CLI)' }))
  view.rerender(
    <AgentSessionContinuationDialog
      {...props}
      request={{
        ...request,
        source: { ...request.source, sourceAgent: 'gemini' },
        avoidSourceAgent: true,
        initialCwd: '/repo/subfolder',
        groupId: 'replacement-group'
      }}
    />
  )
  fireEvent.click(screen.getAllByRole('combobox')[0])
  expect(screen.queryAllByRole('option', { name: /Gemini/ })).toHaveLength(0)
  fireEvent.click(screen.getByRole('option', { name: 'Claude (CLI)' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start New Session' })))
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agent: 'claude',
      initialCwd: '/repo/subfolder',
      groupId: 'replacement-group',
      launchChoice: expect.objectContaining({ requestedSurface: 'terminal' })
    })
  )
})

it('explains an empty host inventory when the enabled agent has no chat preference', async () => {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      defaultTuiAgent: 'grok',
      disabledTuiAgents: getAgentCatalog()
        .filter((agent) => agent.id !== 'grok')
        .map((agent) => agent.id),
      nativeChatProviders: { grok: false }
    }
  })
  mocks.detection.mockReturnValue({ ...detection, detectedIds: [] })
  render(<AgentSessionContinuationDialog open request={request} onOpenChange={vi.fn()} />, {
    wrapper: TooltipProvider
  })
  await act(async () => {})
  expect(screen.getByText('No enabled Agents were detected on this workspace host.')).toBeTruthy()
  const start = screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' })
  expect(start.disabled).toBe(true)
  fireEvent.click(start)
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('explains the excluded source family in Spanish', async () => {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      disabledTuiAgents: getAgentCatalog()
        .filter((agent) => agent.id !== 'claude' && agent.id !== 'claude-agent-teams')
        .map((agent) => agent.id)
    }
  })
  mocks.detection.mockReturnValue({ ...detection, detectedIds: ['claude', 'claude-agent-teams'] })
  try {
    await i18n.changeLanguage(await loadRendererUiLanguage('es'))
    render(
      <AgentSessionContinuationDialog
        open
        request={{
          ...request,
          source: { ...request.source, sourceAgent: 'claude' },
          avoidSourceAgent: true
        }}
        onOpenChange={vi.fn()}
      />,
      { wrapper: TooltipProvider }
    )
    expect(
      screen.getByText(
        'En el host de este espacio de trabajo solo hay disponibles agentes que comparten el límite de uso con Claude. Activa o instala un agente diferente.'
      )
    ).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Iniciar sesión nueva' }).disabled
    ).toBe(true)
  } finally {
    await i18n.changeLanguage('en')
  }
})

it('keeps an unavailable alternative and its explanation when the source family is excluded', () => {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      disabledTuiAgents: getAgentCatalog()
        .filter((agent) => !['claude', 'claude-agent-teams', 'codex'].includes(agent.id))
        .map((agent) => agent.id)
    }
  })
  mocks.detection.mockReturnValue({ ...detection, detectedIds: ['claude', 'claude-agent-teams'] })
  render(
    <AgentSessionContinuationDialog
      open
      request={{
        ...request,
        source: { ...request.source, sourceAgent: 'claude' },
        avoidSourceAgent: true
      }}
      onOpenChange={vi.fn()}
    />,
    { wrapper: TooltipProvider }
  )
  expect(screen.queryByText(/Only Agents sharing|No enabled Agents were detected/)).toBeNull()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
  ).toBe(true)
  fireEvent.click(screen.getAllByRole('combobox')[0])
  expect(screen.getByRole('option', { name: /Codex/ }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByText('Not installed')).toBeTruthy()
  expect(screen.queryAllByRole('option', { name: /Claude/ })).toHaveLength(0)
})

it('ignores a detected agent this build does not know when explaining the excluded family', () => {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      disabledTuiAgents: getAgentCatalog()
        .filter((agent) => agent.id !== 'claude')
        .map((agent) => agent.id)
    }
  })
  // A newer paired host can report an agent id this build has no config for.
  const detectedIds = ['claude', 'future-agent'] as TuiAgent[]
  mocks.detection.mockReturnValue({ ...detection, detectedIds })
  render(
    <AgentSessionContinuationDialog
      open
      request={{
        ...request,
        source: { ...request.source, sourceAgent: 'claude' },
        avoidSourceAgent: true
      }}
      onOpenChange={vi.fn()}
    />,
    { wrapper: TooltipProvider }
  )
  expect(
    screen.getByText(
      'Only Agents sharing the usage limit with Claude are available on this workspace host. Enable or install a different Agent.'
    )
  ).toBeTruthy()
})

// Last: the host's published chat availability outlives this test.
it('explains the excluded family when the source agent is offered only as a chat', async () => {
  setLocalRuntimeCapabilitiesForTests([CHAT, AVAILABILITY])
  vi.spyOn(rpc, 'subscribeRuntimeRpc').mockImplementation(
    async (_target, _method, _params, handlers) => {
      queueMicrotask(() =>
        handlers.onEvent({
          type: 'availability',
          agents: [{ agent: 'codex', state: 'available', chatProgram: 'available' }]
        })
      )
      return { unsubscribe: () => {} }
    }
  )
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      disabledTuiAgents: getAgentCatalog()
        .filter((agent) => agent.id !== 'codex')
        .map((agent) => agent.id)
    }
  })
  mocks.detection.mockReturnValue({ ...detection, detectedIds: [] })
  render(
    <AgentSessionContinuationDialog
      open
      request={{
        ...request,
        source: { ...request.source, sourceAgent: 'codex' },
        avoidSourceAgent: true
      }}
      onOpenChange={vi.fn()}
    />,
    { wrapper: TooltipProvider }
  )
  await act(async () => {})
  expect(
    screen.getByText(
      'Only Agents sharing the usage limit with Codex are available on this workspace host. Enable or install a different Agent.'
    )
  ).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start New Session' }).disabled
  ).toBe(true)
})
