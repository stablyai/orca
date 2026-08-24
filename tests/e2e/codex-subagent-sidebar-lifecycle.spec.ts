import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'

import type { AgentHookEndpoint } from '../../src/shared/agent-hook-endpoint-file'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function subagentActivity(
  sessionId: string,
  agentPath: string,
  kind: 'started' | 'interrupted',
  occurredAtMs: number
): string {
  return jsonl([
    {
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        occurred_at_ms: occurredAtMs,
        agent_thread_id: sessionId,
        agent_path: agentPath,
        kind
      }
    }
  ])
}

function childTranscript({
  sessionId,
  parentSessionId,
  cwd,
  progressMarker,
  inheritedUserMarker,
  inheritedAssistantMarker,
  activityStartedAt
}: {
  sessionId: string
  parentSessionId: string
  cwd: string
  progressMarker: string
  inheritedUserMarker: string
  inheritedAssistantMarker: string
  activityStartedAt: number
}): string {
  const inheritedTimestamp = new Date(activityStartedAt - 1).toISOString()
  const childTimestamp = new Date(activityStartedAt + 1).toISOString()
  return jsonl([
    {
      type: 'session_meta',
      timestamp: inheritedTimestamp,
      payload: {
        id: sessionId,
        cwd,
        thread_source: 'subagent',
        forked_from_id: parentSessionId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentSessionId,
              depth: 1,
              agent_path: '/root/e2e_child'
            }
          }
        }
      }
    },
    {
      type: 'response_item',
      timestamp: inheritedTimestamp,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: inheritedUserMarker }]
      }
    },
    {
      type: 'response_item',
      timestamp: inheritedTimestamp,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: inheritedAssistantMarker }]
      }
    },
    {
      type: 'event_msg',
      timestamp: childTimestamp,
      payload: { type: 'task_started' }
    },
    {
      type: 'response_item',
      timestamp: childTimestamp,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: progressMarker }]
      }
    }
  ])
}

async function postCodexHook(
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
    throw new Error(`Codex hook POST returned ${response.status}`)
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

function parentAgentRow(page: Page, prompt: string) {
  return page.getByRole('treeitem').filter({ hasText: prompt }).first()
}

async function expandSingleChild(page: Page, prompt: string): Promise<void> {
  const disclosure = parentAgentRow(page, prompt).locator('button[aria-expanded]')
  await expect(disclosure).toBeVisible({ timeout: 15_000 })
  if ((await disclosure.getAttribute('aria-expanded')) === 'false') {
    await disclosure.click()
  }
}

test.describe('Codex subagent sidebar lifecycle', () => {
  test('discovers, opens, removes, and rediscovers dynamically spawned children', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await enableInlineAgentCards(orcaPage)

    const endpoint = await readHookEndpoint(electronApp)
    const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(orcaPage)
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const cwd = await orcaPage.evaluate((targetWorktreeId) => {
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
    const firstChildId = randomUUID()
    const secondChildId = randomUUID()
    const parentPath = path.join(dayDirectory, `rollout-e2e-parent-${parentSessionId}.jsonl`)
    const firstChildPath = path.join(dayDirectory, `rollout-e2e-child-${firstChildId}.jsonl`)
    const secondChildPath = path.join(dayDirectory, `rollout-e2e-child-${secondChildId}.jsonl`)
    const prompt = `CODEX_DYNAMIC_PARENT_${startedAt}`
    const firstProgress = `FIRST_CHILD_PROGRESS_${startedAt}`
    const secondProgress = `SECOND_CHILD_PROGRESS_${startedAt}`
    const firstInheritedUser = `FIRST_PARENT_HISTORY_USER_${startedAt}`
    const firstInheritedAssistant = `FIRST_PARENT_HISTORY_ASSISTANT_${startedAt}`
    const secondInheritedUser = `SECOND_PARENT_HISTORY_USER_${startedAt}`
    const secondInheritedAssistant = `SECOND_PARENT_HISTORY_ASSISTANT_${startedAt}`

    writeFileSync(
      parentPath,
      jsonl([
        {
          type: 'session_meta',
          timestamp: new Date(startedAt).toISOString(),
          payload: { id: parentSessionId, cwd }
        },
        {
          type: 'event_msg',
          timestamp: new Date(startedAt).toISOString(),
          payload: { type: 'task_started' }
        }
      ])
    )
    writeFileSync(
      firstChildPath,
      childTranscript({
        sessionId: firstChildId,
        parentSessionId,
        cwd,
        progressMarker: firstProgress,
        inheritedUserMarker: firstInheritedUser,
        inheritedAssistantMarker: firstInheritedAssistant,
        activityStartedAt: startedAt + 1
      })
    )
    writeFileSync(
      secondChildPath,
      childTranscript({
        sessionId: secondChildId,
        parentSessionId,
        cwd,
        progressMarker: secondProgress,
        inheritedUserMarker: secondInheritedUser,
        inheritedAssistantMarker: secondInheritedAssistant,
        activityStartedAt: startedAt + 3
      })
    )

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

    await expect(orcaPage.getByText(prompt, { exact: true })).toBeVisible({ timeout: 15_000 })

    appendFileSync(
      parentPath,
      subagentActivity(firstChildId, '/root/first_live_child', 'started', startedAt + 1)
    )
    await expandSingleChild(orcaPage, prompt)
    const firstChild = orcaPage
      .getByRole('treeitem')
      .filter({ hasText: 'first_live_child' })
      .first()
    await expect(firstChild).toBeVisible({ timeout: 15_000 })
    await firstChild.click()

    const progressSheet = orcaPage.locator('[data-codex-subagent-progress]')
    await expect(progressSheet).toBeVisible({ timeout: 15_000 })
    await expect(
      progressSheet.getByRole('heading', { name: '/root/first_live_child', exact: true })
    ).toBeVisible()
    await expect(progressSheet.getByText(firstProgress, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(progressSheet.getByText(firstInheritedUser, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(firstInheritedAssistant, { exact: true })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(progressSheet).toBeHidden()

    appendFileSync(
      parentPath,
      subagentActivity(firstChildId, '/root/first_live_child', 'interrupted', startedAt + 2)
    )
    await expect(orcaPage.getByText('first_live_child', { exact: true })).toHaveCount(0, {
      timeout: 15_000
    })
    await expect(parentAgentRow(orcaPage, prompt).locator('button[aria-expanded]')).toHaveCount(0)

    appendFileSync(
      parentPath,
      subagentActivity(secondChildId, '/root/second_live_child', 'started', startedAt + 3)
    )
    await expandSingleChild(orcaPage, prompt)
    const secondChild = orcaPage
      .getByRole('treeitem')
      .filter({ hasText: 'second_live_child' })
      .first()
    await expect(secondChild).toBeVisible({ timeout: 15_000 })
    await secondChild.click()
    await expect(progressSheet.getByText(secondProgress, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(progressSheet.getByText(secondInheritedUser, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(secondInheritedAssistant, { exact: true })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(progressSheet).toBeHidden()

    appendFileSync(
      secondChildPath,
      jsonl([{ type: 'event_msg', payload: { type: 'task_complete' } }])
    )
    await expect(orcaPage.getByText('second_live_child', { exact: true })).toHaveCount(0, {
      timeout: 15_000
    })
    await expect(parentAgentRow(orcaPage, prompt).locator('button[aria-expanded]')).toHaveCount(0)
    await expect(parentAgentRow(orcaPage, prompt).getByLabel('Done', { exact: true })).toBeVisible()
  })
})
