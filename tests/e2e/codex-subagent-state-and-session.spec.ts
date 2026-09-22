import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { test, expect } from './helpers/orca-app'
import {
  appendCodexRecords,
  appendSubagentActivity,
  childAgentRow,
  codexEvent,
  codexJsonl,
  codexProgressSheet,
  codexResponse,
  expandParentChildren,
  parentAgentRow,
  postCodexHook,
  startCodexSubagentScenario,
  writeChildRollout,
  type CodexSubagentE2EContext
} from './helpers/codex-subagent-rollout-fixture'

test.describe('Codex subagent state and session boundaries', () => {
  test('recovers a late rollout and renders idle, resumed, waiting, and completed states', async ({
    orcaPage,
    electronApp
  }) => {
    const context = await startCodexSubagentScenario({
      page: orcaPage,
      electronApp,
      promptPrefix: 'CODEX_STATE_PARENT'
    })
    const childId = randomUUID()
    const childStartedAt = context.startedAt + 10
    const agentPath = '/root/state_transitions'
    const initialProgress = `STATE_INITIAL_${context.startedAt}`
    const resumedProgress = `STATE_RESUMED_${context.startedAt}`
    const answeredProgress = `STATE_ANSWERED_${context.startedAt}`

    appendSubagentActivity(context, childId, agentPath, 'started', childStartedAt)
    await expandParentChildren(orcaPage, context.prompt)
    const childRow = childAgentRow(orcaPage, childId)
    await expect(childRow).toBeVisible({ timeout: 15_000 })
    await childRow.click()

    const progressSheet = codexProgressSheet(orcaPage)
    await expect(progressSheet).toBeVisible({ timeout: 15_000 })
    await expect(
      progressSheet.getByText('Waiting for subagent output…', { exact: true })
    ).toBeVisible()

    const childPath = writeChildRollout({
      context,
      sessionId: childId,
      agentPath,
      startedAt: childStartedAt,
      records: [
        codexResponse(childStartedAt + 1, {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: initialProgress }]
        })
      ]
    })
    await expect(progressSheet.getByText(initialProgress, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(childRow.getByLabel('Working')).toBeVisible()
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Working')).toBeVisible()

    appendCodexRecords(childPath, [
      codexResponse(childStartedAt + 2, {
        type: 'function_call',
        name: 'wait_agent',
        call_id: 'wait-1',
        arguments: '{}'
      })
    ])
    await expect(childRow.getByLabel('Idle')).toBeVisible({ timeout: 15_000 })
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Done')).toBeVisible()
    await expect(progressSheet.getByText('Idle', { exact: true })).toBeVisible()

    appendCodexRecords(childPath, [
      codexResponse(childStartedAt + 3, {
        type: 'function_call_output',
        call_id: 'wait-1',
        output: ''
      }),
      codexEvent(childStartedAt + 4, { type: 'agent_message', message: resumedProgress })
    ])
    await expect(childRow.getByLabel('Working')).toBeVisible({ timeout: 15_000 })
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Working')).toBeVisible()
    await expect(progressSheet.getByText('Working', { exact: true })).toBeVisible()
    await expect(progressSheet.getByText(resumedProgress, { exact: true })).toBeVisible()

    appendCodexRecords(childPath, [
      codexResponse(childStartedAt + 5, {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'question-1',
        arguments: '{"questions":[]}'
      })
    ])
    await expect(childRow.getByLabel('Waiting for input')).toBeVisible({ timeout: 15_000 })
    await expect(
      parentAgentRow(orcaPage, context.prompt).getByLabel('Waiting for input')
    ).toBeVisible()
    await expect(progressSheet.getByText('Waiting for input', { exact: true })).toBeVisible()

    appendCodexRecords(childPath, [
      codexResponse(childStartedAt + 6, {
        type: 'function_call_output',
        call_id: 'question-1',
        output: 'confirmed'
      }),
      codexEvent(childStartedAt + 7, { type: 'agent_message', message: answeredProgress })
    ])
    await expect(childRow.getByLabel('Working')).toBeVisible({ timeout: 15_000 })
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Working')).toBeVisible()
    await expect(progressSheet.getByText(answeredProgress, { exact: true })).toBeVisible()

    appendCodexRecords(childPath, [codexEvent(childStartedAt + 8, { type: 'task_complete' })])
    await expect(childAgentRow(orcaPage, childId)).toHaveCount(0, {
      timeout: 15_000
    })
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Done')).toBeVisible()
    await expect(progressSheet.getByText('Idle', { exact: true })).toBeVisible()
    await expect(progressSheet.getByText(answeredProgress, { exact: true })).toBeVisible()
  })

  test('drops the prior child roster when the parent pane starts a new Codex session', async ({
    orcaPage,
    electronApp
  }) => {
    const firstContext = await startCodexSubagentScenario({
      page: orcaPage,
      electronApp,
      promptPrefix: 'CODEX_FIRST_SESSION'
    })
    const oldChildId = randomUUID()
    const oldStartedAt = firstContext.startedAt + 10
    const oldProgress = `OLD_CHILD_PROGRESS_${firstContext.startedAt}`
    writeChildRollout({
      context: firstContext,
      sessionId: oldChildId,
      agentPath: '/root/old_session_child',
      startedAt: oldStartedAt,
      records: [codexEvent(oldStartedAt + 1, { type: 'agent_message', message: oldProgress })]
    })
    appendSubagentActivity(
      firstContext,
      oldChildId,
      '/root/old_session_child',
      'started',
      oldStartedAt
    )
    await expandParentChildren(orcaPage, firstContext.prompt)
    await expect(childAgentRow(orcaPage, oldChildId)).toBeVisible({ timeout: 15_000 })

    const nextSessionId = randomUUID()
    const nextStartedAt = firstContext.startedAt + 100
    const nextPrompt = `CODEX_NEXT_SESSION_${firstContext.startedAt}`
    const nextParentPath = path.join(
      firstContext.dayDirectory,
      `rollout-e2e-parent-${nextSessionId}.jsonl`
    )
    writeFileSync(
      nextParentPath,
      codexJsonl([
        {
          type: 'session_meta',
          timestamp: new Date(nextStartedAt).toISOString(),
          payload: { id: nextSessionId, cwd: firstContext.cwd }
        },
        codexEvent(nextStartedAt, { type: 'task_started' })
      ])
    )
    const nextContext: CodexSubagentE2EContext = {
      ...firstContext,
      parentPath: nextParentPath,
      parentSessionId: nextSessionId,
      prompt: nextPrompt,
      startedAt: nextStartedAt
    }
    await postCodexHook(firstContext.endpoint, {
      paneKey: firstContext.paneKey,
      worktreeId: firstContext.worktreeId,
      payload: {
        hook_event_name: 'SessionStart',
        session_id: nextSessionId,
        transcript_path: nextParentPath
      }
    })
    await postCodexHook(firstContext.endpoint, {
      paneKey: firstContext.paneKey,
      worktreeId: firstContext.worktreeId,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: nextSessionId,
        transcript_path: nextParentPath,
        prompt: nextPrompt
      }
    })
    await postCodexHook(firstContext.endpoint, {
      paneKey: firstContext.paneKey,
      worktreeId: firstContext.worktreeId,
      payload: {
        hook_event_name: 'Stop',
        session_id: nextSessionId,
        transcript_path: nextParentPath
      }
    })
    await expect(orcaPage.getByText(nextPrompt, { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(childAgentRow(orcaPage, oldChildId)).toHaveCount(0)

    const staleChildId = randomUUID()
    const currentChildId = randomUUID()
    const staleStartedAt = nextStartedAt + 10
    const currentStartedAt = nextStartedAt + 20
    writeChildRollout({
      context: firstContext,
      sessionId: staleChildId,
      agentPath: '/root/stale_watcher_child',
      startedAt: staleStartedAt,
      records: [codexEvent(staleStartedAt + 1, { type: 'agent_message', message: 'STALE_WATCHER' })]
    })
    const currentProgress = `CURRENT_CHILD_PROGRESS_${firstContext.startedAt}`
    const currentInherited = `CURRENT_PARENT_PREFIX_${firstContext.startedAt}`
    const currentChildPath = writeChildRollout({
      context: nextContext,
      sessionId: currentChildId,
      agentPath: '/root/current_session_child',
      startedAt: currentStartedAt,
      inheritedUserMarker: currentInherited,
      records: [
        codexEvent(currentStartedAt + 1, {
          type: 'agent_message',
          message: currentProgress
        })
      ]
    })
    appendSubagentActivity(
      firstContext,
      staleChildId,
      '/root/stale_watcher_child',
      'started',
      staleStartedAt
    )
    appendSubagentActivity(
      nextContext,
      currentChildId,
      '/root/current_session_child',
      'started',
      currentStartedAt
    )

    await expandParentChildren(orcaPage, nextPrompt)
    const currentRow = childAgentRow(orcaPage, currentChildId)
    await expect(currentRow).toBeVisible({ timeout: 15_000 })
    await expect(childAgentRow(orcaPage, staleChildId)).toHaveCount(0)
    await currentRow.click()
    const progressSheet = codexProgressSheet(orcaPage)
    await expect(progressSheet.getByText(currentProgress, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(progressSheet.getByText(oldProgress, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(currentInherited, { exact: true })).toHaveCount(0)

    appendCodexRecords(currentChildPath, [
      codexEvent(currentStartedAt + 2, { type: 'task_complete' })
    ])
    await expect(childAgentRow(orcaPage, currentChildId)).toHaveCount(0, {
      timeout: 15_000
    })
    await expect(parentAgentRow(orcaPage, nextPrompt).getByLabel('Done')).toBeVisible()
  })
})
