export function hostedIosNativeChatStateExpression(
  expectedText?: string,
  expectedPlaceholder?: string
): string {
  return `(() => {
    const expectedText = ${JSON.stringify(expectedText?.toLowerCase() ?? null)}
    const expectedPlaceholder = ${JSON.stringify(expectedPlaceholder ?? null)}
    const bodyText = String(document.body?.innerText ?? '')
    const composer = document.querySelector('[aria-label="Send message"]')
    const input = [...document.querySelectorAll('input,textarea')]
      .find((element) => element.getAttribute('placeholder') === expectedPlaceholder)
    const hasText = expectedText === null || bodyText.toLowerCase().includes(expectedText)
    const hasPlaceholder = expectedPlaceholder === null || input != null
    return composer && hasText && hasPlaceholder
      ? 'visible'
      : JSON.stringify({
          bodyText: bodyText.slice(-2048),
          hasComposer: composer != null,
          placeholders: [...document.querySelectorAll('input,textarea')]
            .map((element) => element.getAttribute('placeholder'))
            .filter(Boolean)
        })
  })()`
}

export const hostedIosNativeChatTabDiagnosticExpression = `(() => {
  if (!String(location.href).startsWith('orca-mobile-web://')) {
    return 'not-hosted'
  }
  const root = document.getElementById('root')
  const rootKey = root && Object.getOwnPropertyNames(root)
    .find((key) => key.startsWith('__reactContainer$'))
  const pending = rootKey ? [root[rootKey]] : []
  const records = []
  const viewOverrides = []
  const disconnectRetentions = []
  const chatTargets = []
  const shellStates = []
  const transportStates = []
  let visited = 0
  while (pending.length > 0 && visited < 12000) {
    const fiber = pending.pop()
    visited += 1
    let hook = fiber?.memoizedState
    let hookIndex = 0
    while (hook && hookIndex < 1000) {
      const value = hook.memoizedState
      const candidates = Array.isArray(value)
        ? value
        : Array.isArray(value?.current)
          ? value.current
          : null
      if (candidates?.some((candidate) => candidate?.type === 'terminal')) {
        records.push(candidates
          .filter((candidate) => candidate?.type === 'terminal')
          .map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            terminal: candidate.terminal,
            launchAgent: candidate.launchAgent,
            nativeChatSessionId: candidate.nativeChatSessionId,
            agentState: candidate.agentStatus?.state,
            agentType: candidate.agentStatus?.agentType
          })))
      }
      if (value?.overrides instanceof Map) {
        viewOverrides.push({
          hostId: value.hostId,
          worktreeId: value.worktreeId,
          loaded: value.loaded,
          overrides: [...value.overrides.entries()]
        })
      }
      const current = value?.current
      if (current?.resolution?.sessionId && current?.tabId) {
        disconnectRetentions.push({
          hostId: current.hostId,
          worktreeId: current.worktreeId,
          tabId: current.tabId,
          agent: current.resolution.agent,
          sessionId: current.resolution.sessionId
        })
      }
      if (current?.workspaceId && current?.agent && current?.sessionId) {
        chatTargets.push({
          workspaceId: current.workspaceId,
          agent: current.agent,
          sessionId: current.sessionId,
          terminalId: current.terminalId
        })
      }
      if (
        value?.context?.shellSessionId &&
        ['connecting', 'connected', 'offline', 'recovering'].includes(value.connection)
      ) {
        shellStates.push({
          connection: value.connection,
          reconnectAttempts: value.reconnectAttempts,
          shellSessionId: value.context.shellSessionId
        })
      }
      if (value === 'available' || value === 'unavailable') {
        transportStates.push(value)
      }
      hook = hook.next
      hookIndex += 1
    }
    if (fiber?.child) {
      pending.push(fiber.child)
    }
    if (fiber?.sibling) {
      pending.push(fiber.sibling)
    }
  }
  return JSON.stringify({
    hasRoot: root != null,
    hasFiber: rootKey != null,
    visited,
    records,
    viewOverrides,
    disconnectRetentions,
    chatTargets,
    shellStates,
    transportStates
  })
})()`
