import { randomUUID } from 'node:crypto'

import { test, expect } from './helpers/orca-app'
import {
  appendCodexRecords,
  appendSubagentActivity,
  childAgentRow,
  codexEvent,
  codexProgressSheet,
  codexResponse,
  expandParentChildren,
  parentAgentRow,
  startCodexSubagentScenario,
  writeChildRollout
} from './helpers/codex-subagent-rollout-fixture'

test.describe('Codex concurrent subagent progress', () => {
  test('switches isolated live transcripts and removes concurrent children independently', async ({
    orcaPage,
    electronApp
  }) => {
    const context = await startCodexSubagentScenario({
      page: orcaPage,
      electronApp,
      promptPrefix: 'CODEX_CONCURRENT_PARENT'
    })
    const firstChildId = randomUUID()
    const secondChildId = randomUUID()
    const firstStartedAt = context.startedAt + 10
    const secondStartedAt = context.startedAt + 20
    const firstPath = '/root/concurrent_first'
    const secondPath = '/root/concurrent_second'
    const firstInitial = `FIRST_INITIAL_${context.startedAt}`
    const firstReasoning = `FIRST_REASONING_${context.startedAt}`
    const firstToolOutput = `FIRST_TOOL_OUTPUT_${context.startedAt}`
    const firstFinal = `FIRST_FINAL_${context.startedAt}`
    const secondInitial = `SECOND_INITIAL_${context.startedAt}`
    const firstInherited = `FIRST_INHERITED_PARENT_${context.startedAt}`
    const secondInherited = `SECOND_INHERITED_PARENT_${context.startedAt}`

    const firstChildPath = writeChildRollout({
      context,
      sessionId: firstChildId,
      agentPath: firstPath,
      startedAt: firstStartedAt,
      inheritedUserMarker: firstInherited,
      records: [
        codexResponse(firstStartedAt + 1, {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: firstInitial }]
        })
      ]
    })
    const secondChildPath = writeChildRollout({
      context,
      sessionId: secondChildId,
      agentPath: secondPath,
      startedAt: secondStartedAt,
      inheritedAssistantMarker: secondInherited,
      records: [
        codexResponse(secondStartedAt + 1, {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: secondInitial }]
        })
      ]
    })
    appendSubagentActivity(context, firstChildId, firstPath, 'started', firstStartedAt)
    appendSubagentActivity(context, secondChildId, secondPath, 'started', secondStartedAt)

    await expandParentChildren(orcaPage, context.prompt)
    const firstRow = childAgentRow(orcaPage, 'concurrent_first')
    const secondRow = childAgentRow(orcaPage, 'concurrent_second')
    await expect(firstRow).toBeVisible({ timeout: 15_000 })
    await expect(secondRow).toBeVisible({ timeout: 15_000 })
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Working')).toBeVisible()

    await firstRow.click()
    const progressSheet = codexProgressSheet(orcaPage)
    await expect(progressSheet).toBeVisible({ timeout: 15_000 })
    await expect(progressSheet.getByRole('heading', { name: firstPath, exact: true })).toBeVisible()
    await expect(progressSheet.getByText(firstInitial, { exact: true })).toBeVisible()
    await expect(progressSheet.getByText(firstInherited, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(secondInitial, { exact: true })).toHaveCount(0)
    await expect(firstRow).toHaveAttribute('aria-selected', 'true')
    await expect(secondRow).toHaveAttribute('aria-selected', 'false')

    appendCodexRecords(firstChildPath, [
      codexResponse(firstStartedAt + 2, {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: firstReasoning }]
      }),
      codexResponse(firstStartedAt + 3, {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'git status --short'
      }),
      codexResponse(firstStartedAt + 4, {
        type: 'custom_tool_call_output',
        output: [{ type: 'input_text', text: firstToolOutput }]
      }),
      codexEvent(firstStartedAt + 5, { type: 'agent_message', message: firstFinal })
    ])
    await expect(progressSheet.getByText(firstReasoning, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(progressSheet.getByText(firstFinal, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    const toolRun = progressSheet.getByRole('button').filter({ hasText: '1×' }).first()
    await expect(toolRun).toBeVisible()
    await toolRun.click()
    await expect(progressSheet.locator('pre').filter({ hasText: firstToolOutput })).toBeVisible()

    await secondRow.click()
    await expect(
      progressSheet.getByRole('heading', { name: secondPath, exact: true })
    ).toBeVisible()
    await expect(progressSheet.getByText(secondInitial, { exact: true })).toBeVisible()
    await expect(progressSheet.getByText(secondInherited, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(firstInitial, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(firstReasoning, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(firstToolOutput, { exact: true })).toHaveCount(0)
    await expect(progressSheet.getByText(firstFinal, { exact: true })).toHaveCount(0)
    await expect(firstRow).toHaveAttribute('aria-selected', 'false')
    await expect(secondRow).toHaveAttribute('aria-selected', 'true')

    appendCodexRecords(firstChildPath, [codexEvent(firstStartedAt + 6, { type: 'task_complete' })])
    await expect(childAgentRow(orcaPage, 'concurrent_first')).toHaveCount(0, {
      timeout: 15_000
    })
    await expect(secondRow).toBeVisible()
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Working')).toBeVisible()

    appendCodexRecords(secondChildPath, [
      codexEvent(secondStartedAt + 2, { type: 'task_complete' })
    ])
    await expect(childAgentRow(orcaPage, 'concurrent_second')).toHaveCount(0, {
      timeout: 15_000
    })
    await expect(parentAgentRow(orcaPage, context.prompt).getByLabel('Done')).toBeVisible()
    await expect(progressSheet).toBeVisible()
    await expect(progressSheet.getByText('Idle', { exact: true })).toBeVisible()
    await expect(progressSheet.getByText(secondInitial, { exact: true })).toBeVisible()
  })
})
