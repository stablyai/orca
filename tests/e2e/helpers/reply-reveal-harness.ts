/**
 * Drives one Orca app through reply-reveal scenarios: opens stand-in agent tabs, submits as a person
 * (Playwright keys through xterm) or as Orca (terminal.send), ends turns, and records
 * whether main revealed the agent's tab for each completion.
 */
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-types'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './terminal'
import { resolveActiveTabId } from './terminal-pane-identity'
import { waitForPtyShellEcho } from '../terminal-pty-readiness'
import {
  controlFakeReplyAgent,
  countAcceptedFakeReplyHooks,
  type FakeReplyAgentProvider
} from './reply-reveal-fake-agent'
import {
  activateTab,
  createTerminalTab,
  installReplyRevealProbes,
  readActiveView,
  readReplyRevealProbe,
  type ReplyRevealProbeLog
} from './reply-reveal-probes'

export type ReplyAgentTab = {
  provider: FakeReplyAgentProvider
  fakeDir: string
  tabId: string
  paneKey: string
  worktreeId: string
  handle: string
}

export type ReplyRevealOutcome = {
  scenario: string
  expected: boolean
  revealed: boolean
  reveals: number
  banners: number
}

export class ReplyRevealHarness {
  readonly outcomes: ReplyRevealOutcome[] = []

  constructor(
    readonly page: Page,
    readonly app: ElectronApplication,
    private readonly client: RuntimeClient,
    private readonly decoyTabId: string,
    private readonly fakeDir: string,
    private readonly agentScript: string
  ) {}

  async openAgent(provider: FakeReplyAgentProvider): Promise<ReplyAgentTab> {
    const fakeDir = mkdtempSync(path.join(this.fakeDir, `${provider}-`))
    const tabId = await createTerminalTab(this.page)
    const { worktreeId } = await readActiveView(this.page)
    const ptyId = await waitForActivePanePtyId(this.page)
    await waitForPtyShellEcho(this.page, ptyId, 30_000)
    const { paneKey } = await waitForActivePaneHookDescriptor(this.page)
    // A program write launches the agent, as Orca's own launch path does.
    await sendToTerminal(
      this.page,
      ptyId,
      `exec node '${this.agentScript}' ${provider} '${fakeDir}'\r`
    )
    await waitForTerminalOutput(this.page, `[fake] ${provider} ready`, 20_000)
    if (provider === 'claude') {
      await expect
        .poll(() => countAcceptedFakeReplyHooks(fakeDir, provider, 'SessionStart'), {
          timeout: 20_000
        })
        .toBe(1)
    }
    let handle: string | undefined
    await expect
      .poll(
        async () => {
          const list = await this.client.call<RuntimeTerminalListResult>('terminal.list')
          handle = list.result.terminals.find((terminal) => terminal.tabId === tabId)?.handle
          return handle ?? null
        },
        { timeout: 20_000 }
      )
      .not.toBeNull()
    return { provider, fakeDir, tabId, paneKey, worktreeId: worktreeId ?? '', handle: handle ?? '' }
  }

  hooks(agent: ReplyAgentTab, name: string): number {
    return countAcceptedFakeReplyHooks(agent.fakeDir, agent.provider, name)
  }

  async humanType(agent: ReplyAgentTab, text: string): Promise<void> {
    await activateTab(this.page, agent.tabId)
    await focusActiveTerminalInput(this.page)
    if (text) {
      await this.page.keyboard.type(text)
    }
    await this.page.keyboard.press('Enter')
  }

  async programSend(agent: ReplyAgentTab, text: string): Promise<void> {
    await this.client.call('terminal.send', { terminal: agent.handle, text, enter: true })
  }

  async waitForSubmissions(agent: ReplyAgentTab, count: number): Promise<void> {
    await expect.poll(() => this.hooks(agent, 'UserPromptSubmit'), { timeout: 15_000 }).toBe(count)
  }

  async lookElsewhere(): Promise<void> {
    await activateTab(this.page, this.decoyTabId)
  }

  /** Shows the other seeded workspace, so the agent's workspace is not the active one. */
  async lookAtOtherWorkspace(): Promise<void> {
    await this.page.evaluate(() => {
      const state = window.__store!.getState()
      const active = state.activeWorktreeId
      const other = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id !== active)
      if (!other) {
        throw new Error('No second workspace to look at')
      }
      state.setActiveWorktree(other.id)
    })
  }

  async complete(scenario: string, agent: ReplyAgentTab, expected: boolean): Promise<void> {
    const stops = this.hooks(agent, 'Stop')
    const before = await readReplyRevealProbe(this.app)
    controlFakeReplyAgent(agent.fakeDir, agent.provider, 'finish')
    await expect.poll(() => this.hooks(agent, 'Stop'), { timeout: 15_000 }).toBe(stops + 1)
    const since = async (): Promise<ReplyRevealProbeLog> => {
      const log = await readReplyRevealProbe(this.app)
      return {
        banners: log.banners.slice(before.banners.length),
        reveals: log.reveals.slice(before.reveals.length)
      }
    }
    const paneReveals = (log: ReplyRevealProbeLog): number =>
      log.reveals.filter(
        (reveal) => reveal.channel === 'ui:focusTerminal' && reveal.paneKey === agent.paneKey
      ).length
    await expect.poll(async () => (await since()).banners.length, { timeout: 10_000 }).toBe(1)
    if (expected) {
      await expect.poll(async () => paneReveals(await since()), { timeout: 10_000 }).toBe(1)
    } else {
      // A new submission invalidates this completion, including any provenance still being read.
      const submitted = this.hooks(agent, 'UserPromptSubmit')
      await this.programSend(agent, 'next program turn')
      await this.waitForSubmissions(agent, submitted + 1)
    }
    const log = await since()
    const revealed = paneReveals(log) > 0
    const strayReveals = log.reveals.filter(
      (reveal) =>
        !(
          (reveal.channel === 'ui:focusTerminal' && reveal.paneKey === agent.paneKey) ||
          (reveal.channel === 'ui:activateWorktree' && reveal.worktreeId === agent.worktreeId)
        )
    )
    const outcome = {
      scenario,
      expected,
      revealed,
      reveals: log.reveals.length,
      banners: log.banners.length
    }
    this.outcomes.push(outcome)
    console.log(`[reply-reveal] ${JSON.stringify(outcome)}`)
    expect.soft(revealed, `${scenario}: reveal`).toBe(expected)
    if (expected) {
      expect.soft(paneReveals(log), `${scenario}: pane reveals`).toBe(1)
      expect.soft(strayReveals, `${scenario}: reveals of anything but its pane`).toEqual([])
    } else {
      expect.soft(log.reveals, `${scenario}: any reveal`).toEqual([])
    }
    expect.soft(log.banners.length, `${scenario}: banners`).toBe(1)
    if (revealed) {
      const view = await readActiveView(this.page)
      expect.soft(view.tabId, `${scenario}: revealed tab`).toBe(agent.tabId)
      expect.soft(view.worktreeId, `${scenario}: revealed workspace`).toBe(agent.worktreeId)
    }
  }
}

export async function setUpReplyRevealHarness(
  page: Page,
  app: ElectronApplication,
  fakeDir: string,
  agentScript: string
): Promise<ReplyRevealHarness> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const decoyTabId = await resolveActiveTabId(page)
  if (!decoyTabId) {
    throw new Error('The seeded worktree has no terminal tab to look at')
  }
  await installReplyRevealProbes(app)
  await page.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({
      notifications: {
        ...state.settings!.notifications,
        enabled: true,
        agentTaskComplete: true,
        bringToFrontOnAgentTaskComplete: true
      }
    })
  })
  const userDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  return new ReplyRevealHarness(page, app, client, decoyTabId, fakeDir, agentScript)
}
