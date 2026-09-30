import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it } from 'vitest'
import { readCodexSessionOptionsFromTerminalScreen } from './codex-terminal-session-options'

const CODEX_0158_SCREEN = [
  '  >_ OpenAI Codex (v0.158.0)',
  '     ~/repo',
  '  permissions: YOLO mode',
  '› test 123',
  '• Received: test 123.',
  '› Ask Codex to do anything',
  '  GPT-6-Sol xhigh · ~/repo · Test 123',
  '  ? for shortcuts'
].join('\n')

describe('Codex terminal session option detection', () => {
  it('reads the model and effort from captured Codex 0.157.1 terminal bytes', async () => {
    const transcript = readFileSync(
      join(
        __dirname,
        '../../../../main/runtime/__fixtures__/codex-0157-no-daemon-effort-override.txt'
      ),
      'utf8'
    )
    const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    const serializer = new SerializeAddon()
    terminal.loadAddon(serializer)
    try {
      await new Promise<void>((resolve) => terminal.write(transcript, resolve))
      expect(
        readCodexSessionOptionsFromTerminalScreen(serializer.serialize({ scrollback: 0 }))
      ).toEqual({
        model: 'GPT-6-Sol',
        effort: 'high'
      })
    } finally {
      terminal.dispose()
    }
  })

  it('reads a newer live footer and keeps an unlisted model label', () => {
    expect(readCodexSessionOptionsFromTerminalScreen(CODEX_0158_SCREEN)).toEqual({
      model: 'GPT-6-Sol',
      effort: 'xhigh'
    })
  })

  it('resolves a displayed model against the host model list', () => {
    expect(
      readCodexSessionOptionsFromTerminalScreen(CODEX_0158_SCREEN, [
        { id: 'gpt-6-sol', label: 'GPT-6-Sol', options: [] }
      ])
    ).toEqual({ model: 'gpt-6-sol', effort: 'xhigh' })
  })

  it('keeps reading after the Codex header scrolls off the screen', () => {
    expect(readCodexSessionOptionsFromTerminalScreen('GPT-6-Sol xhigh · ~/repo')).toEqual({
      model: 'GPT-6-Sol',
      effort: 'xhigh'
    })
  })

  it('does not read a loading placeholder or a message without footer structure', () => {
    expect(readCodexSessionOptionsFromTerminalScreen('GPT-6-Sol xhigh')).toBeNull()
    expect(
      readCodexSessionOptionsFromTerminalScreen(
        '  >_ OpenAI Codex (v0.158.0)\n  loading default · ~/repo'
      )
    ).toBeNull()
  })
})
