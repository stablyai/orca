import type { Page } from '@stablyai/playwright-test'

export async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__store
      ?.getState()
      .updateSettings({ nativeChatProviders: { claude: true, codex: true } })
  })
}

export async function seedClaudeProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e first-flush race probe', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
  }, args)
}

export async function toggleTerminalTabToChatView(
  page: Page,
  args: { tabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate(({ tabId, worktreeId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found for chat toggle')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

export function claudeTranscriptLines(args: {
  sessionId: string
  messageIdPrefix?: string
  userText: string
  assistantText: string
}): string {
  const userTime = new Date()
  const assistantTime = new Date(userTime.getTime() + 2_000)
  const lines = [
    {
      sessionId: args.sessionId,
      uuid: `${args.messageIdPrefix ?? args.sessionId}-user`,
      timestamp: userTime.toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: args.userText }] }
    },
    {
      sessionId: args.sessionId,
      uuid: `${args.messageIdPrefix ?? args.sessionId}-assistant`,
      timestamp: assistantTime.toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: args.assistantText }] }
    }
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

/** Observe only structural lifecycle evidence; never keep PTY bytes, prompts or transcript contents. */
export async function observeTranscriptPaneLifetime(
  page: Page,
  args: { tabId: string; worktreeId: string; paneKey: string }
) {
  const handle = await page.evaluateHandle(({ tabId, worktreeId, paneKey }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable for transcript lifetime observation')
    }
    const events: {
      at: number
      source: string
      snapshot: string
      detail: unknown
      stack?: string
    }[] = []
    let overflow = 0
    let previous = ''
    const managers = new WeakMap<object, number>()
    const ownedPtys = new Set<string>()
    let managerId = 0
    const snapshot = () => {
      const state = store.getState()
      const manager = window.__paneManagers?.get(tabId)
      if (manager && !managers.has(manager)) {
        managers.set(manager, ++managerId)
      }
      const layout = state.terminalLayoutsByTabId[tabId]
      for (const id of Object.values(layout?.ptyIdsByLeafId ?? {})) {
        ownedPtys.add(id)
      }
      const status = state.agentStatusByPaneKey[paneKey]
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.entityId === tabId
      )
      return JSON.stringify({
        worktreeId,
        tabId,
        paneKey,
        activeWorktreeId: state.activeWorktreeId,
        unifiedTabId: tab?.id,
        viewMode: tab?.viewMode,
        manager: manager ? managers.get(manager) : null,
        activeLeafId: manager?.getActivePane()?.leafId,
        panes: manager?.getPanes().map((pane) => ({
          id: pane.id,
          leafId: pane.leafId,
          ptyId: pane.container.dataset.ptyId
        })),
        ptyIdsByLeafId: layout?.ptyIdsByLeafId,
        chatLeafId: layout?.chatLeafId,
        status: status
          ? {
              state: status.state,
              agentType: status.agentType,
              providerSessionId: status.providerSession?.id,
              connectionId: status.connectionId
            }
          : null
      })
    }
    const record = (source: string, detail: unknown = null) => {
      const current = snapshot()
      if (source === 'store' || source === 'pane-dom') {
        if (current === previous) {
          return
        }
      }
      previous = current
      if (events.length === 160) {
        overflow++
        return
      }
      events.push({
        at: performance.now(),
        source,
        snapshot: current,
        detail,
        stack: new Error('Transcript pane lifecycle observation').stack
      })
    }
    record('initial')
    const unsubscribe = store.subscribe(() => record('store'))
    const offFacts = window.api.pty.onSideEffect((batch) => {
      if (batch.tabId !== tabId && !ownedPtys.has(batch.ptyId)) {
        return
      }
      record('main-side-effect', {
        ptyId: batch.ptyId,
        paneKey: batch.paneKey,
        tabId: batch.tabId,
        worktreeId: batch.worktreeId,
        seq: batch.seq,
        replay: batch.replay,
        facts: batch.facts.map((fact) =>
          fact.kind === 'command-finished'
            ? { kind: fact.kind, exitCode: fact.exitCode }
            : { kind: fact.kind }
        )
      })
    })
    const offExit = window.api.pty.onExit((event) => {
      record('pty-exit', { ...event, owned: ownedPtys.has(event.id) })
    })
    const offSpawn = window.api.pty.onSpawned((event) => {
      record('pty-spawned', { ...event, owned: ownedPtys.has(event.id) })
    })
    const observer = new MutationObserver(() => record('pane-dom'))
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-pty-id']
    })
    return {
      finish: () => {
        record('final')
        unsubscribe()
        offFacts()
        offExit()
        offSpawn()
        observer.disconnect()
        return { events, overflow }
      }
    }
  }, args)
  return async () => {
    try {
      return await handle.evaluate((observer) => observer.finish())
    } catch (error) {
      return { captureError: String(error) }
    } finally {
      await handle.dispose().catch(() => {})
    }
  }
}
