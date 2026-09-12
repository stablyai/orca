import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'

import { stripAnsiEscapeSequences } from '../../../src/shared/ansi-escape-sequences'
import { ensureTerminalVisible } from './store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './terminal'

export const STA4746_PROBE = 'STA4746PROBE'

// Why `;;`: values are absolute paths, so a separator that cannot appear in one
// keeps parsing exact — a substring match would accept a sibling directory that
// merely has the expected path as a prefix.
const FIELD_SEPARATOR = ';;'
// Why a terminating field: a narrow terminal wraps the probe line, so a read can
// catch it half-rendered. Refusing anything without `end=1` keeps a truncated
// value from being asserted as the real cwd.
const END_FIELD = 'end'

export type Sta4746Probe = Record<string, string>

function probeHead(phase: string): string {
  // Trailing separator so phase `a` cannot match a probe for phase `a-b`.
  return `${STA4746_PROBE}${FIELD_SEPARATOR}phase=${phase}${FIELD_SEPARATOR}`
}

export function sta4746ProbeCommand(phase: string, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    pwd: '"$PWD"',
    oldpwd: '"$OLDPWD"',
    wt: '"$ORCA_WORKTREE_ID"',
    root: '"$ORCA_WORKSPACE_ROOT"',
    ...extra,
    [END_FIELD]: '1'
  }
  const keys = Object.keys(fields)
  const format = keys.map((key) => `${FIELD_SEPARATOR}${key}=%s`).join('')
  const args = keys.map((key) => fields[key]).join(' ')
  return `printf '${STA4746_PROBE}${FIELD_SEPARATOR}phase=${phase}${format}\\n' ${args}`
}

function parseProbeSegment(segment: string): Sta4746Probe {
  const fields: Sta4746Probe = {}
  for (const chunk of segment.split(FIELD_SEPARATOR)) {
    const separator = chunk.indexOf('=')
    if (separator > 0) {
      fields[chunk.slice(0, separator).trim()] = chunk.slice(separator + 1).trim()
    }
  }
  return fields
}

/** Parses one complete probe record out of raw terminal text, else null. */
export function parseSta4746Probe(content: string, phase: string): Sta4746Probe | null {
  const head = probeHead(phase)
  const terminator = `${FIELD_SEPARATOR}${END_FIELD}=1`
  const stripped = stripAnsiEscapeSequences(content)
  // Second pass with rows joined: a hard wrap can split the record across rows.
  for (const candidate of [stripped, stripped.replaceAll('\n', '')]) {
    const start = candidate.lastIndexOf(head)
    if (start === -1) {
      continue
    }
    // Bound at the record's own terminator. Without this the joined pass runs to
    // end of buffer and can absorb `key=value` text from unrelated later rows.
    const row = candidate.slice(start).split('\n')[0] ?? ''
    const end = row.indexOf(terminator)
    if (end === -1) {
      continue
    }
    return parseProbeSegment(row.slice(0, end + terminator.length))
  }
  return null
}

export async function readSta4746Probe(page: Page, phase: string): Promise<Sta4746Probe> {
  let probe: Sta4746Probe | null = null
  await expect
    .poll(
      async () => {
        probe = parseSta4746Probe(await getTerminalContent(page, 12_000), phase)
        return probe?.pwd ?? ''
      },
      { timeout: 90_000, message: `probe line for phase ${phase} never rendered` }
    )
    .not.toBe('')
  if (!probe) {
    throw new Error(`probe for phase ${phase} did not parse`)
  }
  console.log(`[sta4746] ${phase}: ${JSON.stringify(probe)}`)
  return probe
}

export type Sta4746ProbeRun = {
  probe: Sta4746Probe
  /** Caller closes this so phases do not accumulate PTYs on a shared app fixture. */
  tabId: string
}

/**
 * Opens a fresh terminal in `workspaceKey`, pins who owns its PTY, then probes.
 * `expectedPtyOwner` is load-bearing: when hosts share a filesystem, a PTY
 * spawned by the wrong host still satisfies every path assertion.
 */
export async function probeWorkspaceTerminal(args: {
  page: Page
  workspaceKey: string
  phase: string
  expectedPtyOwner: RegExp
  extraFields?: Record<string, string>
  suffixCommand?: string
}): Promise<Sta4746ProbeRun> {
  const { page, workspaceKey, phase, expectedPtyOwner } = args
  const tabId = await page.evaluate((key) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveWorktree(key)
    const tab = store.getState().createTab(key, undefined, undefined, { activate: true })
    store.getState().setActiveTab(tab.id)
    store.getState().setActiveTabType('terminal')
    return tab.id
  }, workspaceKey)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  const ptyId = await waitForActivePanePtyId(page, 60_000)
  expect(ptyId, `phase ${phase} did not get the expected PTY owner`).toMatch(expectedPtyOwner)
  await focusActiveTerminalInput(page)
  const command = sta4746ProbeCommand(phase, args.extraFields)
  await page.keyboard.type(args.suffixCommand ? `${command}; ${args.suffixCommand}` : command)
  await page.keyboard.press('Enter')
  return { probe: await readSta4746Probe(page, phase), tabId }
}

export async function closeSta4746Tabs(page: Page, tabIds: readonly string[]): Promise<void> {
  await page
    .evaluate((ids) => {
      const store = window.__store
      for (const id of ids) {
        store?.getState().closeTab(id)
      }
    }, tabIds)
    .catch(() => undefined)
}
