import os from 'node:os'
import type { Page } from '@stablyai/playwright-test'
import type { IBuffer } from '@xterm/xterm'

const MACHINE_IDENTITY_KINDS = ['username', 'hostname', 'short-hostname', 'home'] as const

/** One machine-identifying value a captured screenshot must never show. */
export type MachineIdentityKind = (typeof MACHINE_IDENTITY_KINDS)[number]

export type MachineIdentity = Record<MachineIdentityKind, string>

/** What the guard read from the renderer before a capture and what it found there. */
export type ScreenshotIdentityGuardRecord = {
  screenshot: string
  renderedTextChars: number
  terminalBuffers: number
  terminalChars: number
  leaks: MachineIdentityKind[]
}

type RenderedText = { dom: string; terminals: string[] }

export function readMachineIdentity(): MachineIdentity {
  const hostname = os.hostname()
  return {
    username: os.userInfo().username,
    hostname,
    'short-hostname': hostname.split('.')[0],
    home: os.homedir()
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Names every identity kind the text shows, ignoring case; the username only as a whole word. */
export function findMachineIdentityLeaks(
  text: string,
  identity: MachineIdentity
): MachineIdentityKind[] {
  const haystack = text.toLowerCase()
  return MACHINE_IDENTITY_KINDS.filter((kind) => {
    const needle = identity[kind].toLowerCase()
    return kind === 'username'
      ? new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack)
      : haystack.includes(needle)
  })
}

/** The renderer's visible text and field values plus every terminal buffer, mounted or parked. */
export function readRenderedText(page: Page): Promise<RenderedText> {
  return page.evaluate(() => {
    const bufferText = (buffer: IBuffer): string => {
      let text = ''
      for (let y = 0; y < buffer.length; y += 1) {
        const line = buffer.getLine(y)!
        const wrapsOn = buffer.getLine(y + 1)?.isWrapped === true
        text += `${line.translateToString(!wrapsOn)}${wrapsOn ? '' : '\n'}`
      }
      return text
    }
    const panes = [...(window.__paneManagers?.values() ?? [])].flatMap((manager) =>
      manager.getPanes()
    )
    const parked = Object.values(window.__store!.getState().localOnlyScrollbackByTabId).flatMap(
      (byLeaf) => Object.values(byLeaf)
    )
    const fieldValues = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
    ].map((field) => field.value)
    return {
      dom: [document.title, document.body.innerText, ...fieldValues].join('\n'),
      terminals: [
        ...panes.flatMap((pane) => [
          bufferText(pane.terminal.buffer.normal),
          bufferText(pane.terminal.buffer.alternate)
        ]),
        ...parked
      ]
    }
  })
}

/** Reads the renderer and reports whether a capture of it would show this machine's identity. */
export async function guardScreenshotAgainstMachineIdentity(
  page: Page,
  screenshot: string
): Promise<ScreenshotIdentityGuardRecord> {
  const { dom, terminals } = await readRenderedText(page)
  return {
    screenshot,
    renderedTextChars: dom.length,
    terminalBuffers: terminals.length,
    terminalChars: terminals.reduce((sum, text) => sum + text.length, 0),
    leaks: findMachineIdentityLeaks([dom, ...terminals].join('\n'), readMachineIdentity())
  }
}
