import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isZCodeInteractiveTuiOutput, isZCodeMissingTuiOutput } from './zcode-missing-tui'

const FIXTURE = join(__dirname, '..', 'main', 'runtime', '__fixtures__', 'zcode-missing-tui.txt')

describe('isZCodeMissingTuiOutput', () => {
  it('matches the recorded desktop-bundle failure byte for byte', () => {
    expect(isZCodeMissingTuiOutput(readFileSync(FIXTURE, 'utf8'))).toBe(true)
  })

  it('matches the CJS spelling of the same failure', () => {
    expect(isZCodeMissingTuiOutput("Error: Cannot find module '@zcode/tui'")).toBe(true)
  })

  it('matches the desktop wrapper that reports its omitted TUI package', () => {
    expect(
      isZCodeMissingTuiOutput(
        'zcode: TUI 不可用 — App 包未内置 @zcode/tui。\nzcode: 请使用 headless 模式。'
      )
    ).toBe(true)
    expect(isZCodeMissingTuiOutput('ZCode TUI is not available: missing @zcode/tui')).toBe(true)
  })

  it('does not match a build that has the TUI but no TTY', () => {
    expect(isZCodeMissingTuiOutput('TUI requires an interactive terminal.')).toBe(false)
  })

  it('does not match the localized form of that same healthy message', () => {
    expect(isZCodeMissingTuiOutput('TUI 需要交互式终端。')).toBe(false)
  })

  it('does not match an unrelated missing package', () => {
    expect(isZCodeMissingTuiOutput("Cannot find package 'left-pad' imported from x.js")).toBe(false)
  })

  it('does not match prose that merely mentions the package', () => {
    expect(isZCodeMissingTuiOutput('install @zcode/tui to get the terminal UI')).toBe(false)
    expect(isZCodeMissingTuiOutput('TUI is unavailable while the terminal initializes')).toBe(false)
  })
})

describe('isZCodeInteractiveTuiOutput', () => {
  it('matches the official English and Chinese non-TTY diagnostics', () => {
    expect(isZCodeInteractiveTuiOutput('TUI requires an interactive terminal.')).toBe(true)
    expect(isZCodeInteractiveTuiOutput('TUI 需要交互式终端。')).toBe(true)
  })

  it('does not infer TUI support from generic terminal failures', () => {
    expect(isZCodeInteractiveTuiOutput('not a tty')).toBe(false)
    expect(isZCodeInteractiveTuiOutput('interactive terminal unavailable')).toBe(false)
  })
})
