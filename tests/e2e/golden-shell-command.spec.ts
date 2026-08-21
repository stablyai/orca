import { stripAnsiEscapeSequences } from '../../src/shared/ansi-escape-sequences'
import { test, expect } from './helpers/mcode-app'
import { ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const CSI_REPLY_RE = /997;[12]n/

function shellBasename(processName: string): string {
  return processName
    .replaceAll('\\', '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
}

test('seeded project terminal runs a typed shell command @golden', async ({ mcodePage }) => {
  await ensureTerminalVisible(mcodePage, 30_000)
  await waitForActiveTerminalManager(mcodePage, 30_000)
  const ptyId = await waitForActivePanePtyId(mcodePage, 30_000)
  expect(await getTerminalContent(mcodePage)).not.toMatch(CSI_REPLY_RE)

  const marker = `mcode-e2e-alive-${Date.now()}`
  await focusActiveTerminalInput(mcodePage)
  await mcodePage.keyboard.type(`echo ${marker}`)
  await mcodePage.keyboard.press('Enter')
  await expect
    .poll(async () => (await getTerminalContent(mcodePage)).split(marker).length - 1, {
      message: 'marker should appear in both the echoed command and command output'
    })
    .toBeGreaterThanOrEqual(2)

  if (process.platform === 'win32') {
    let foregroundProcess = ''
    await expect
      .poll(async () => {
        foregroundProcess =
          (await mcodePage.evaluate((id) => window.api.pty.inspectProcess(id), ptyId))
            .foregroundProcess ?? ''
        return foregroundProcess
      })
      .not.toBe('')
    const shell = shellBasename(foregroundProcess)
    if (shell === 'cmd') {
      const pwshAvailable = await mcodePage.evaluate(() => window.api.pwsh.isAvailable())
      expect(pwshAvailable, 'cmd.exe must not replace an available PowerShell default').toBe(false)
    }
    const begin = 'MCODE_E2E_PATH_BEGIN'
    const end = 'MCODE_E2E_PATH_END'
    const pathCommand =
      shell === 'pwsh' || shell === 'powershell'
        ? `Write-Output ${begin}; Write-Output $env:LOCALAPPDATA; Write-Output ${end}`
        : shell === 'cmd'
          ? `echo ${begin} & echo %LOCALAPPDATA% & echo ${end}`
          : `printf '${begin}\\n%s\\n${end}\\n' "$LOCALAPPDATA"`
    await focusActiveTerminalInput(mcodePage)
    await mcodePage.keyboard.type(pathCommand)
    await mcodePage.keyboard.press('Enter')
    let expandedPath = ''
    await expect
      .poll(async () => {
        // Why: the echoed command can wrap or be clipped by the buffer tail, so only a
        // line that is exactly the marker — bracketed by both markers — is real output.
        const lines = stripAnsiEscapeSequences(await getTerminalContent(mcodePage, 8_000))
          .split(/\r?\n/)
          .map((line) => line.trim())
        const beginLine = lines.lastIndexOf(begin)
        const endLine = beginLine === -1 ? -1 : lines.indexOf(end, beginLine + 1)
        expandedPath =
          endLine === -1 ? '' : (lines.slice(beginLine + 1, endLine).find(Boolean) ?? '')
        return expandedPath
      })
      .not.toBe('')

    expect(expandedPath).not.toBe('')
    expect(expandedPath).not.toBe('%LOCALAPPDATA%')
    expect(expandedPath).not.toBe('$env:LOCALAPPDATA')
    expect(expandedPath).toMatch(/(?:[A-Za-z]:\\|\\\\)/)
  }

  const finalBuffer = await getTerminalContent(mcodePage, 8_000)
  expect(finalBuffer).not.toMatch(CSI_REPLY_RE)
})
