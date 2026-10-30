import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isZCodeMissingTuiOutput } from './zcode-missing-tui'

const FIXTURE = join(__dirname, '..', 'main', 'runtime', '__fixtures__', 'zcode-missing-tui.txt')

describe('isZCodeMissingTuiOutput', () => {
  it('matches the recorded desktop-bundle failure byte for byte', () => {
    expect(isZCodeMissingTuiOutput(readFileSync(FIXTURE, 'utf8'))).toBe(true)
  })

  it('matches the CJS spelling of the same failure', () => {
    expect(isZCodeMissingTuiOutput("Error: Cannot find module '@zcode/tui'")).toBe(true)
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
  })
})
