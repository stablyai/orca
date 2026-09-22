import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'

import type { AgentHookEndpoint } from '../../../src/shared/agent-hook-endpoint-file'
import { readHookEndpoint } from './agent-hook-endpoint'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './store'

export type CodexSubagentE2EContext = {
  cwd: string
  dayDirectory: string
  endpoint: AgentHookEndpoint
  paneKey: string
  parentPath: string
  parentSessionId: string
  prompt: string
  startedAt: number
  worktreeId: string
}

export function codexJsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

export function codexEvent(at: number, payload: Record<string, unknown>): unknown {
  return {
    type: 'event_msg',
    timestamp: new Date(at).toISOString(),
    payload
  }
}

export function codexResponse(at: number, payload: Record<string, unknown>): unknown {
  return {
    type: 'response_item',
    timestamp: new Date(at).toISOString(),
    payload
  }
}

export function childRolloutPath(context: CodexSubagentE2EContext, sessionId: string): string {
  return path.join(context.dayDirectory, `rollout-e2e-child-${sessionId}.jsonl`)
}

export function appendCodexRecords(filePath: string, records: readonly unknown[]): void {
  appendFileSync(filePath, codexJsonl(records))
}

export function writeChildRollout(args: {
  context: CodexSubagentE2EContext
  sessionId: string
  agentPath: string
  startedAt: number
  records?: readonly unknown[]
  inheritedUserMarker?: string
  inheritedAssistantMarker?: string
}): string {
  const inheritedAt = args.startedAt - 1
  const records: unknown[] = [
    {
      type: 'session_meta',
      timestamp: new Date(inheritedAt).toISOString(),
      payload: {
        id: args.sessionId,
        cwd: args.context.cwd,
        thread_source: 'subagent',
        forked_from_id: args.context.parentSessionId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: args.context.parentSessionId,
              depth: 1,
              agent_path: args.agentPath
            }
          }
        }
      }
    }
  ]
  if (args.inheritedUserMarker) {
    records.push(
      codexResponse(inheritedAt, {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: args.inheritedUserMarker }]
      })
    )
  }
  if (args.inheritedAssistantMarker) {
    records.push(
      codexResponse(inheritedAt, {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: args.inheritedAssistantMarker }]
      })
    )
  }
  records.push(codexEvent(args.startedAt, { type: 'task_started' }), ...(args.records ?? []))

  const filePath = childRolloutPath(args.context, args.sessionId)
  writeFileSync(filePath, codexJsonl(records))
  return filePath
}

export function appendSubagentActivity(
  context: CodexSubagentE2EContext,
  sessionId: string,
  agentPath: string,
  kind: 'started' | 'interacted' | 'interrupted',
  occurredAt: number
): void {
  appendCodexRecords(context.parentPath, [
    codexEvent(occurredAt, {
      type: 'sub_agent_activity',
      occurred_at_ms: occurredAt,
      agent_thread_id: sessionId,
      agent_path: agentPath,
      kind
    })
  ])
}

export async function postCodexHook(
  endpoint: AgentHookEndpoint,
  event: {
    paneKey: string
    worktreeId: string
    payload: Record<string, unknown>
  }
): Promise<void> {
  const [tabId] = event.paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: event.paneKey,
      tabId,
      worktreeId: event.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      payload: event.payload
    })
  })
  if (response.status !== 204) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Codex hook POST returned ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`
    )
  }
}

async function enableInlineAgentCards(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.toggleWorktreeCardProperty('inline-agents')
    }
    state.closeActivityPage()
  })
}

export async function startCodexSubagentScenario(args: {
  page: Page
  electronApp: ElectronApplication
  promptPrefix: string
}): Promise<CodexSubagentE2EContext> {
  await waitForSessionReady(args.page)
  await waitForActiveWorktree(args.page)
  await ensureTerminalVisible(args.page)
  await waitForActiveTerminalManager(args.page)
  await enableInlineAgentCards(args.page)

  const endpoint = await readHookEndpoint(args.electronApp)
  const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(args.page)
  const isolatedHome = await args.electronApp.evaluate(({ app }) => app.getPath('home'))
  const cwd = await args.page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const worktree = Object.values(store.getState().worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === targetWorktreeId)
    if (!worktree) {
      throw new Error(`Worktree ${targetWorktreeId} was not found`)
    }
    return worktree.path
  }, worktreeId)

  const startedAt = Date.now()
  const date = new Date(startedAt)
  const dayDirectory = path.join(
    isolatedHome,
    '.codex',
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  )
  mkdirSync(dayDirectory, { recursive: true })

  const parentSessionId = randomUUID()
  const parentPath = path.join(dayDirectory, `rollout-e2e-parent-${parentSessionId}.jsonl`)
  const prompt = `${args.promptPrefix}_${startedAt}`
  writeFileSync(
    parentPath,
    codexJsonl([
      {
        type: 'session_meta',
        timestamp: new Date(startedAt).toISOString(),
        payload: { id: parentSessionId, cwd }
      },
      codexEvent(startedAt, { type: 'task_started' })
    ])
  )
  const context = {
    cwd,
    dayDirectory,
    endpoint,
    paneKey,
    parentPath,
    parentSessionId,
    prompt,
    startedAt,
    worktreeId
  }
  await postCodexHook(endpoint, {
    paneKey,
    worktreeId,
    payload: {
      hook_event_name: 'UserPromptSubmit',
      session_id: parentSessionId,
      transcript_path: parentPath,
      prompt
    }
  })
  await postCodexHook(endpoint, {
    paneKey,
    worktreeId,
    payload: {
      hook_event_name: 'Stop',
      session_id: parentSessionId,
      transcript_path: parentPath
    }
  })
  await args.page.getByText(prompt, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  return context
}

export function parentAgentRow(page: Page, prompt: string): Locator {
  return page.getByRole('treeitem').filter({ hasText: prompt }).first()
}

export function childAgentRow(page: Page, sessionId: string): Locator {
  return page.locator(`[role="treeitem"][data-subagent-id="${sessionId}"]`)
}

export function codexProgressSheet(page: Page): Locator {
  return page.locator('[data-codex-subagent-progress]')
}

export async function expandParentChildren(page: Page, prompt: string): Promise<void> {
  const disclosure = parentAgentRow(page, prompt).locator('button[aria-expanded]')
  await disclosure.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await disclosure.getAttribute('aria-expanded')) === 'false') {
    await disclosure.click()
  }
}
