/**
 * Drives one Orca app through reply-reveal scenarios: opens stand-in agent tabs, submits as a person
 * (Playwright keys through xterm) or as Orca (terminal.send, dictation paste), ends turns, and records
 * whether main revealed the agent's tab for each completion.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { NOTIFICATION_COOLDOWN_MS } from '../../../src/shared/notification-burst-cooldown'
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
  readFakeReplyAgentStdin,
  type FakeReplyAgentProvider
} from './reply-reveal-fake-agent'
import {
  activateTab,
  advanceReplyRevealClock,
  setBringToFront,
  createTerminalTab,
  installReplyRevealProbes,
  readActiveView,
  readReplyRevealProbe,
  type ReplyRevealProbeLog
} from './reply-reveal-probes'

export type ReplyAgentTab = {
  provider: FakeReplyAgentProvider
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
  private pendingRefusal?: (log: ReplyRevealProbeLog) => Promise<void>

  constructor(
    readonly page: Page,
    readonly app: ElectronApplication,
    private readonly client: RuntimeClient,
    private readonly decoyTabId: string,
    private readonly fakeDir: string,
    private readonly agentScript: string
  ) {}

  async openAgent(provider: FakeReplyAgentProvider): Promise<ReplyAgentTab> {
    const tabId = await createTerminalTab(this.page)
    const { worktreeId } = await readActiveView(this.page)
    const ptyId = await waitForActivePanePtyId(this.page)
    await waitForPtyShellEcho(this.page, ptyId, 30_000)
    const { paneKey } = await waitForActivePaneHookDescriptor(this.page)
    // A program write launches the agent, as Orca's own launch path does.
    await sendToTerminal(
      this.page,
      ptyId,
      `exec node '${this.agentScript}' ${provider} '${this.fakeDir}'\r`
    )
    await waitForTerminalOutput(this.page, `[fake] ${provider} ready`, 20_000)
    if (provider === 'claude') {
      await expect.poll(() => this.hooks(provider, 'SessionStart'), { timeout: 20_000 }).toBe(1)
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
    return { provider, tabId, paneKey, worktreeId: worktreeId ?? '', handle: handle ?? '' }
  }

  hooks(provider: FakeReplyAgentProvider, name: string): number {
    return countAcceptedFakeReplyHooks(this.fakeDir, provider, name)
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

  /** Fills the draft through dictation's insert, which Orca writes as a program paste. */
  async dictateDraft(agent: ReplyAgentTab, text: string): Promise<void> {
    await activateTab(this.page, agent.tabId)
    await focusActiveTerminalInput(this.page)
    await this.page.evaluate(
      ({ tabId, text }) => {
        document.dispatchEvent(new CustomEvent('dictation:insertText', { detail: { tabId, text } }))
      },
      { tabId: agent.tabId, text }
    )
    await expect
      .poll(() => this.stdinContains(agent.provider, text), { timeout: 10_000 })
      .toBe(true)
  }

  private stdinContains(provider: FakeReplyAgentProvider, text: string): boolean {
    return readFakeReplyAgentStdin(this.fakeDir, provider).includes(text)
  }

  async waitForSubmissions(agent: ReplyAgentTab, count: number): Promise<void> {
    await expect
      .poll(() => this.hooks(agent.provider, 'UserPromptSubmit'), { timeout: 15_000 })
      .toBe(count)
    await this.finishRefusal(await readReplyRevealProbe(this.app))
  }

  private async finishRefusal(log: ReplyRevealProbeLog): Promise<void> {
    const pending = this.pendingRefusal
    this.pendingRefusal = undefined
    await pending?.(log)
  }

  async finishChain(): Promise<void> {
    await setBringToFront(this.page, false)
    await this.finishRefusal(await readReplyRevealProbe(this.app))
  }

  /** Compacts the running turn the way Claude's auto-compaction reports it. */
  async compact(agent: ReplyAgentTab): Promise<void> {
    const starts = this.hooks(agent.provider, 'SessionStart')
    controlFakeReplyAgent(this.fakeDir, agent.provider, 'compact')
    await expect
      .poll(() => this.hooks(agent.provider, 'SessionStart'), { timeout: 10_000 })
      .toBe(starts + 1)
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

  /**
   * Positives reveal the right tab; refusals produce no reveal before the next event.
   * Verdict correctness for refusals is proven in the integration tests.
   */
  async complete(
    scenario: string,
    agent: ReplyAgentTab,
    expected: boolean,
    { wake = false, banners: expectedBanners = 1 }: { wake?: boolean; banners?: 0 | 1 } = {}
  ): Promise<void> {
    const now = await advanceReplyRevealClock(this.app, NOTIFICATION_COOLDOWN_MS)
    await this.page.clock.setSystemTime(now)
    const stops = this.hooks(agent.provider, 'Stop')
    const before = await readReplyRevealProbe(this.app)
    controlFakeReplyAgent(this.fakeDir, agent.provider, wake ? 'wake' : 'finish')
    await expect.poll(() => this.hooks(agent.provider, 'Stop'), { timeout: 15_000 }).toBe(stops + 1)
    await this.finishRefusal(await readReplyRevealProbe(this.app))
    const since = (log: ReplyRevealProbeLog): ReplyRevealProbeLog => ({
      dispatches: log.dispatches.slice(before.dispatches.length),
      banners: log.banners.slice(before.banners.length),
      reveals: log.reveals.slice(before.reveals.length)
    })
    const paneReveals = (log: ReplyRevealProbeLog): number =>
      log.reveals.filter(
        (reveal) => reveal.channel === 'ui:focusTerminal' && reveal.paneKey === agent.paneKey
      ).length
    await expect
      .poll(async () => since(await readReplyRevealProbe(this.app)).dispatches.length, {
        timeout: 15_000
      })
      .toBe(1)
    if (expected) {
      await expect
        .poll(async () => paneReveals(since(await readReplyRevealProbe(this.app))), {
          timeout: 15_000
        })
        .toBe(1)
    }
    const verify = async (end: ReplyRevealProbeLog): Promise<void> => {
      const log = since(end)
      expect(log.dispatches).toEqual([
        {
          paneKey: agent.paneKey,
          result:
            expectedBanners === 0
              ? { delivered: false, reason: 'suppressed-focus' }
              : { delivered: true }
        }
      ])
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
      expect.soft(log.banners.length, `${scenario}: banners`).toBe(expectedBanners)
      if (revealed) {
        const view = await readActiveView(this.page)
        expect.soft(view.tabId, `${scenario}: revealed tab`).toBe(agent.tabId)
        expect.soft(view.worktreeId, `${scenario}: revealed workspace`).toBe(agent.worktreeId)
      }
    }
    if (expected) {
      await verify(await readReplyRevealProbe(this.app))
    } else {
      const delivered = await readReplyRevealProbe(this.app)
      this.pendingRefusal = (end) => verify({ ...delivered, reveals: end.reveals })
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
  await page.clock.install()
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
