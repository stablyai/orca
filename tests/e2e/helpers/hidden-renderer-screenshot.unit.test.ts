// @vitest-environment happy-dom
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureHiddenRendererScreenshot } from './hidden-renderer-screenshot'
import { readMachineIdentity } from './screenshot-machine-identity-guard'

const PNG = Buffer.from('fake-png')

type FakeBufferLine = { isWrapped: boolean; translateToString: () => string }

function fakeBuffer(lines: string[]) {
  return {
    length: lines.length,
    getLine: (y: number): FakeBufferLine | undefined =>
      y < lines.length ? { isWrapped: false, translateToString: () => lines[y] } : undefined
  }
}

function renderTerminal(lines: string[]) {
  const element = document.createElement('div')
  element.className = 'xterm'
  document.body.append(element)
  return { element, buffer: { normal: fakeBuffer(lines), alternate: fakeBuffer([]) } }
}

function exposeTerminals(terminals: ReturnType<typeof renderTerminal>[]): void {
  Object.assign(window, {
    __paneManagers: new Map([
      ['tab-1', { getPanes: () => terminals.map((terminal) => ({ terminal })) }]
    ])
  })
}

function fakePage(): Page {
  const cdp = {
    send: async () => ({ data: PNG.toString('base64') }),
    detach: async () => {}
  }
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg)
  }
  return page as unknown as Page
}

describe('captureHiddenRendererScreenshot', () => {
  let outputDir: string
  let file: string

  const record = () => JSON.parse(readFileSync(`${file}.identity-guard.json`, 'utf8'))

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), 'orca-hidden-capture-'))
    file = path.join(outputDir, 'capture.png')
    document.title = 'Orca'
    document.body.innerHTML = '<main>Recover work from another computer</main>'
    document.getAnimations = () => []
    Object.assign(window, {
      __store: { getState: () => ({ localOnlyScrollbackByTabId: {} }) }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, '__paneManagers')
    Reflect.deleteProperty(window, '__store')
    rmSync(outputDir, { recursive: true, force: true })
  })

  it('writes the PNG when the read covers neutral text and every rendered terminal', async () => {
    exposeTerminals([renderTerminal(['% ls'])])

    await expect(captureHiddenRendererScreenshot(fakePage(), file)).resolves.toEqual(PNG)
    expect(readFileSync(file)).toEqual(PNG)
    expect(record()).toMatchObject({
      screenshot: 'capture.png',
      terminalBuffers: 2,
      unreadTerminals: 0,
      evidenceGaps: [],
      leaks: []
    })
  })

  it('refuses a blank read instead of vouching for it', async () => {
    document.title = ''
    document.body.innerHTML = ' \n '

    await expect(captureHiddenRendererScreenshot(fakePage(), file)).rejects.toThrow(
      "Refusing capture.png: the guard's read was incomplete (blank-rendered-text)"
    )
    expect(existsSync(file)).toBe(false)
    expect(record()).toMatchObject({ evidenceGaps: ['blank-rendered-text'], leaks: [] })
  })

  it('refuses a rendered terminal that no pane manager exposed', async () => {
    renderTerminal(['% ls'])

    await expect(captureHiddenRendererScreenshot(fakePage(), file)).rejects.toThrow(
      "Refusing capture.png: the guard's read was incomplete (unread-terminal)"
    )
    expect(existsSync(file)).toBe(false)
    expect(record()).toMatchObject({
      terminalBuffers: 0,
      unreadTerminals: 1,
      evidenceGaps: ['unread-terminal']
    })
  })

  it("refuses a terminal that shows this machine's home path", async () => {
    exposeTerminals([renderTerminal([`% cd ${readMachineIdentity().home}`])])

    await expect(captureHiddenRendererScreenshot(fakePage(), file)).rejects.toThrow(
      /^Refusing capture\.png: the renderer shows this machine's .*home/
    )
    expect(existsSync(file)).toBe(false)
    expect(record().leaks).toContain('home')
  })
})
