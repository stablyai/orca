import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalShow
} from '../../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../src/shared/terminal-surface-id'
import { expect } from './orca-app'
import { getTerminalContent, waitForActivePanePtyId } from './terminal'

const RECOVERY_DEADLINE_MS = 8_000

export type StartupExecTerminal = {
  hostPtyId: string
  panePtyId: string
  parentTabId: string
  startupMarker: string
  tabId: string
  terminal: string
  worktreeId: string
}

export type BashExecProfileBarrier = {
  releasePath: string
  startedPath: string
}

const BASH_EXEC_LINE = 'exec -a figterm-sta4067 /bin/bash --noprofile --norc -l -i'
const ZSH_EXEC_LINE = 'exec -a figterm-sta4067 /bin/zsh -o noglobalrcs -l -i'

function execProfileContents(
  runId: string,
  execLine: string,
  barrier?: BashExecProfileBarrier
): string {
  const guard = `ORCA_STA4067_EXEC_${runId.replaceAll(/[^A-Za-z0-9_]/g, '_')}`
  const barrierScript = barrier
    ? [
        `: > ${shellQuote(barrier.startedPath)}`,
        `while [[ ! -e ${shellQuote(barrier.releasePath)} ]]; do sleep 0.02; done`
      ].join('\n  ')
    : ''
  return `if [[ -z "\${${guard}:-}" ]]; then
  export ${guard}=1
  ${barrierScript}
  ${execLine}
fi
`
}

export function bashExecProfileContents(runId: string, barrier?: BashExecProfileBarrier): string {
  return execProfileContents(runId, BASH_EXEC_LINE, barrier)
}

export function zshExecProfileContents(runId: string, barrier?: BashExecProfileBarrier): string {
  return execProfileContents(runId, ZSH_EXEC_LINE, barrier)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function splitMarker(marker: string): [string, string] {
  const midpoint = Math.floor(marker.length / 2)
  return [marker.slice(0, midpoint), marker.slice(midpoint)]
}

function markerCommand(marker: string): string {
  const [left, right] = splitMarker(marker)
  return `printf '%s%s\\n' ${shellQuote(left)} ${shellQuote(right)}`
}

function count(text: string, marker: string): number {
  return text.split(marker).length - 1
}

async function expectSingleOwningPty(
  page: Page,
  worktreeId: string,
  tabId: string,
  terminal: string,
  ptyId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await callStartupExecRuntime<RuntimeTerminalListResult>(
          page,
          'terminal.list',
          {
            worktree: `id:${worktreeId}`,
            requireFreshPtyLiveness: true
          }
        )
        return listed.terminals
          .filter((candidate) => candidate.tabId === tabId)
          .map((candidate) => ({ handle: candidate.handle, ptyId: candidate.ptyId }))
      },
      { timeout: 30_000 }
    )
    .toEqual([{ handle: terminal, ptyId }])
}

export async function callStartupExecRuntime<TResult>(
  page: Page,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

export function installBashExecProfile(
  homePath: string,
  runId: string,
  barrier?: BashExecProfileBarrier
): () => void {
  const profilePath = path.join(homePath, '.bash_profile')
  writeFileSync(profilePath, bashExecProfileContents(runId, barrier))
  return () => rmSync(profilePath, { force: true })
}

export function installZshExecProfile(
  homePath: string,
  runId: string,
  barrier?: BashExecProfileBarrier
): () => void {
  const profilePath = path.join(homePath, '.zprofile')
  writeFileSync(profilePath, zshExecProfileContents(runId, barrier))
  return () => rmSync(profilePath, { force: true })
}

export async function createStartupExecTerminal(
  page: Page,
  worktreeId: string,
  runId: string,
  ledgerPath: string,
  tabIdNamespace: 'owning-client' | 'paired-client',
  shell: '/bin/bash' | '/bin/zsh' = '/bin/bash',
  shellEnv: Record<string, string> = {}
): Promise<StartupExecTerminal> {
  const startupMarker = `STA4067_STARTUP_READY_${runId}`
  const command = [
    `printf '%s|%s\\n' "$$" "$(tty)" > ${shellQuote(ledgerPath)}`,
    markerCommand(startupMarker)
  ].join('; ')
  const created = await callStartupExecRuntime<{
    tab: { parentTabId: string; terminal: string | null }
  }>(page, 'session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command,
    env: { ...shellEnv, SHELL: shell },
    startupCommandDelivery: 'shell-ready',
    activate: false,
    select: false,
    navigation: 'caller'
  })
  if (!created.tab.terminal) {
    throw new Error('Startup-exec terminal did not publish an authoritative handle')
  }
  const terminal = created.tab.terminal
  const tabId =
    tabIdNamespace === 'paired-client'
      ? toWebTerminalSurfaceTabId(created.tab.parentTabId)
      : created.tab.parentTabId
  await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
  const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  await expect(tab).toHaveAttribute('data-active', 'true')
  const panePtyId = await waitForActivePanePtyId(page, 30_000)
  const shown = await callStartupExecRuntime<{ terminal: RuntimeTerminalShow }>(
    page,
    'terminal.show',
    { terminal }
  )
  if (!shown.terminal.ptyId) {
    throw new Error('Startup-exec terminal has no owning PTY identity')
  }
  await expectSingleOwningPty(
    page,
    worktreeId,
    created.tab.parentTabId,
    terminal,
    shown.terminal.ptyId
  )
  return {
    hostPtyId: shown.terminal.ptyId,
    panePtyId,
    parentTabId: created.tab.parentTabId,
    startupMarker,
    tabId,
    terminal,
    worktreeId
  }
}

async function readTerminal(page: Page, terminal: string): Promise<RuntimeTerminalRead> {
  return (
    await callStartupExecRuntime<{ terminal: RuntimeTerminalRead }>(page, 'terminal.read', {
      terminal
    })
  ).terminal
}

export async function expectStartupExecRecovery(
  page: Page,
  created: StartupExecTerminal,
  runId: string
): Promise<void> {
  await expect
    .poll(() => readTerminal(page, created.terminal), { timeout: RECOVERY_DEADLINE_MS })
    .toMatchObject({
      tail: expect.arrayContaining([expect.stringContaining(created.startupMarker)])
    })
  await expect
    .poll(() => getTerminalContent(page), { timeout: RECOVERY_DEADLINE_MS })
    .toContain(created.startupMarker)
  const painted = await getTerminalContent(page)
  expect(count(painted, created.startupMarker)).toBe(1)

  const authoritative = await readTerminal(page, created.terminal)
  expect(authoritative.status).toBe('running')
  expect(count(authoritative.tail.join('\n'), created.startupMarker)).toBe(1)
  const shown = await callStartupExecRuntime<{ terminal: RuntimeTerminalShow }>(
    page,
    'terminal.show',
    { terminal: created.terminal }
  )
  expect(shown.terminal).toMatchObject({
    connected: true,
    ptyId: created.hostPtyId,
    writable: true
  })
  await expectSingleOwningPty(
    page,
    created.worktreeId,
    created.parentTabId,
    created.terminal,
    created.hostPtyId
  )

  const inputMarker = `STA4067_FIRST_INPUT_${runId}`
  const textarea = page.locator('.xterm-helper-textarea:visible').first()
  await textarea.focus()
  await page.keyboard.type(markerCommand(inputMarker))
  await page.keyboard.press('Enter')
  await expect
    .poll(() => getTerminalContent(page), { timeout: RECOVERY_DEADLINE_MS })
    .toContain(inputMarker)
  expect(count(await getTerminalContent(page), inputMarker)).toBe(1)
  expect(count((await readTerminal(page, created.terminal)).tail.join('\n'), inputMarker)).toBe(1)
  expect(await waitForActivePanePtyId(page, 30_000)).toBe(created.panePtyId)
}

export async function expectStartupCommandQueuedByCompatibilityFallback(
  page: Page,
  created: StartupExecTerminal
): Promise<void> {
  const [commandEchoMarker] = splitMarker(created.startupMarker)
  await expect
    .poll(() => readTerminal(page, created.terminal), { timeout: RECOVERY_DEADLINE_MS })
    .toMatchObject({ tail: expect.arrayContaining([expect.stringContaining(commandEchoMarker)]) })
  expect(
    count((await readTerminal(page, created.terminal)).tail.join('\n'), commandEchoMarker)
  ).toBe(1)
}

export async function closeStartupExecTerminal(page: Page, terminal: string | null): Promise<void> {
  if (terminal) {
    await callStartupExecRuntime(page, 'terminal.closeTab', { terminal }).catch(() => undefined)
  }
}
