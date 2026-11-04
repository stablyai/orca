/** Opt-in live run: real Claude Code workers execute a Workflow Builder preset end to end. */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { sequentialDevelopmentTemplate } from '../../src/shared/workflow/workflow-templates-development'
import {
  isWorkflowAgentNode,
  type WorkflowPreset
} from '../../src/shared/workflow/workflow-definition-schema'
import type { WorkflowRun } from '../../src/shared/workflow/workflow-run-types'
import { isWorkflowJsonRecord } from '../../src/shared/workflow/workflow-json-record'

const LIVE = process.env.ORCA_E2E_LIVE_AGENTS === '1'
const RUN_BUDGET_MS = 25 * 60_000
const EXPECTED_LINE = 'Workflow Builder live check'

// The isolated E2E HOME cannot see the developer's Claude login, so credentials must come from env.
const CLAUDE_AUTH_IN_ENV = Boolean(
  process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
)

test.skip(!LIVE, 'Set ORCA_E2E_LIVE_AGENTS=1 to launch real Claude Code workers.')
test.skip(
  LIVE && !CLAUDE_AUTH_IN_ENV,
  'Export CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY; the isolated HOME has no Claude login.'
)

async function rpc(page: Page, method: string, params: unknown = {}): Promise<unknown> {
  const response = await page.evaluate(
    async ({ method, params }) => window.api.runtime.call({ method, params }),
    { method, params }
  )
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.code} ${response.error.message}`)
  }
  return response.result
}

async function readLatestRun(page: Page, presetId: string): Promise<WorkflowRun | null> {
  const listed = await rpc(page, 'workflow.runList', { presetId })
  const first = isWorkflowJsonRecord(listed) && Array.isArray(listed.runs) ? listed.runs[0] : null
  if (!isWorkflowJsonRecord(first) || typeof first.id !== 'string') {
    return null
  }
  const got = await rpc(page, 'workflow.runGet', { id: first.id })
  return isWorkflowJsonRecord(got) && isWorkflowJsonRecord(got.run)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: workflow.runGet returns the controller's persisted WorkflowRun record unchanged.
      (got.run as WorkflowRun)
    : null
}

/** Claude-only Sequential Development, sized so one live run stays short. */
function livePreset(): WorkflowPreset {
  const preset = structuredClone(sequentialDevelopmentTemplate())
  preset.id = 'wf-live-check'
  preset.name = 'Live check'
  preset.template = false
  preset.defaultRunSettings.objective = `Create a file named WORKFLOW_LIVE.md at the repository root containing exactly one line: ${EXPECTED_LINE}. Change no other file and do not commit.`
  for (const node of preset.definition.nodes) {
    if (isWorkflowAgentNode(node)) {
      node.agent.runtime = {
        agent: 'claude',
        model: 'sonnet',
        effort: null,
        allowModelFallback: false
      }
      node.agent.execution.timeoutMs = 10 * 60_000
    }
  }
  return preset
}

/** The isolated HOME starts empty; give Claude Code the developer's onboarding state so it does not stop at first-run prompts. */
function seedClaudeConfig(isolatedHome: string): void {
  const source = path.join(os.homedir(), '.claude.json')
  if (existsSync(source)) {
    copyFileSync(source, path.join(isolatedHome, '.claude.json'))
  }
  mkdirSync(path.join(isolatedHome, '.claude'), { recursive: true })
}

test('a Claude-only preset runs through real Orca workers and settles from Orca records', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  // Real agents do real work: the run budget plus launch and teardown headroom.
  test.setTimeout(RUN_BUDGET_MS + 5 * 60_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  seedClaudeConfig(await electronApp.evaluate(({ app }) => app.getPath('home')))
  // Approve for me: Claude's auto mode decides each action; nothing gets blanket full access.
  await orcaPage.evaluate(() => window.api.settings.set({ agentPermissionDefault: 'auto' }))
  await rpc(orcaPage, 'workflow.presetSave', { preset: livePreset() })

  await orcaPage.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(orcaPage.getByTestId('workflow-builder')).toBeVisible({ timeout: 30_000 })
  await orcaPage
    .getByRole('button', { name: /Authentication Feature|Live check/ })
    .first()
    .click()
  await orcaPage.getByRole('menuitem', { name: 'Live check', exact: true }).click()
  await expect(orcaPage.getByTestId('workflow-node-implementer')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('01-design.png') })

  await orcaPage.getByRole('button', { name: 'Run', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Start run', exact: true }).click()

  const latest: { run: WorkflowRun | null } = { run: null }
  const started = Date.now()
  let shot = 0
  await expect
    .poll(
      async () => {
        latest.run = await readLatestRun(orcaPage, 'wf-live-check')
        if (Date.now() - started > shot * 60_000) {
          shot += 1
          await orcaPage.screenshot({ path: testInfo.outputPath(`02-running-${shot}.png`) })
        }
        return latest.run?.status ?? 'not-started'
      },
      { timeout: RUN_BUDGET_MS, intervals: [5_000], message: 'workflow run did not settle' }
    )
    .toMatch(/^(completed|failed|cancelled)$/)
  await orcaPage.screenshot({ path: testInfo.outputPath('03-settled.png') })

  const settled = latest.run
  if (!settled) {
    throw new Error('The run disappeared before it could be inspected.')
  }
  await testInfo.attach('run.json', {
    body: JSON.stringify(settled, null, 2),
    contentType: 'application/json'
  })
  expect(settled.status, settled.error ?? '').toBe('completed')
  // Each agent ran as its own real Orca Task and Dispatch on a real terminal.
  for (const nodeId of ['planner', 'implementer', 'reviewer']) {
    const task = Object.values(settled.tasks).findLast((entry) => entry.nodeId === nodeId)
    expect(task?.status, nodeId).toBe('completed')
    expect(task?.orcaTaskId, nodeId).toMatch(/^task_/)
    expect(task?.dispatches.at(-1)?.orcaDispatchId, nodeId).toMatch(/^ctx_/)
    expect(task?.dispatches.at(-1)?.orcaTerminalHandle, nodeId).toBeTruthy()
  }
  const reviewer = Object.values(settled.tasks).find(
    (entry) => entry.nodeId === 'reviewer' && entry.status === 'completed'
  )
  expect(reviewer?.report?.data.verdict).toBe('approved')
  // Planner → Implementer travelled as the implementer's own task spec, through the controller.
  expect(
    settled.messages.some(
      (message) =>
        message.edgeId === 'c-planner-implementer' && message.deliveryState === 'delivered'
    )
  ).toBe(true)
  const orcaRun = await rpc(orcaPage, 'orchestration.runShow', { id: settled.orcaRunId })
  expect(orcaRun).toMatchObject({ run: { id: settled.orcaRunId } })

  const worktreePath = worktreeId.slice(worktreeId.indexOf('::') + 2)
  expect(readFileSync(path.join(worktreePath, 'WORKFLOW_LIVE.md'), 'utf8').trim()).toBe(
    EXPECTED_LINE
  )
})
