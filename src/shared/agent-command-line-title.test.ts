import { describe, expect, it } from 'vitest'
import { isAgentCommandLineTitle, recognizeAgentCommandLine } from './agent-command-line-title'

describe('recognizeAgentCommandLine', () => {
  it('recognizes Antigravity launch command lines with arguments and flags', () => {
    expect(recognizeAgentCommandLine("agy '--dangerously-s ~/C/orca")).toMatchObject({
      agent: 'antigravity',
      processName: 'agy'
    })
    expect(
      recognizeAgentCommandLine("agy '--dangerously-skip-permissions' ~/Codes/orca")
    ).toMatchObject({
      agent: 'antigravity',
      processName: 'agy'
    })
    expect(
      recognizeAgentCommandLine('agy --dangerously-skip-permissions --model gemini-3.1-pro-high')
    ).toMatchObject({
      agent: 'antigravity',
      processName: 'agy'
    })
  })

  it('recognizes bare agy executable titles as agent command lines', () => {
    expect(recognizeAgentCommandLine('agy')).toMatchObject({
      agent: 'antigravity',
      processName: 'agy'
    })
    expect(recognizeAgentCommandLine('agy.exe')).toMatchObject({
      agent: 'antigravity',
      processName: 'agy'
    })
  })

  it('recognizes other agent launch command lines with flags', () => {
    expect(recognizeAgentCommandLine('claude --dangerously-skip-permissions')).toMatchObject({
      agent: 'claude',
      processName: 'claude'
    })
    expect(recognizeAgentCommandLine('codex --full-auto')).toMatchObject({
      agent: 'codex',
      processName: 'codex'
    })
  })

  it('does not classify agent OSC status or identity titles as command lines', () => {
    expect(recognizeAgentCommandLine('Claude working')).toBeNull()
    expect(recognizeAgentCommandLine('Claude Code')).toBeNull()
    expect(recognizeAgentCommandLine('Claude - action required')).toBeNull()
    expect(recognizeAgentCommandLine('Codex ready')).toBeNull()
    expect(recognizeAgentCommandLine('⠋ Codex is thinking')).toBeNull()
    expect(recognizeAgentCommandLine('Gemini CLI')).toBeNull()
    expect(recognizeAgentCommandLine('Cursor ready')).toBeNull()
    expect(recognizeAgentCommandLine('Pi ready')).toBeNull()
    expect(recognizeAgentCommandLine('agy · Gemini 3.7 Flash')).toBeNull()
    expect(recognizeAgentCommandLine('⠋ agy · Gemini 3.7 Flash · high')).toBeNull()
    expect(recognizeAgentCommandLine('agy "my conversation --draft"')).toBeNull()
  })

  it('does not classify non-agent terminal commands as agent command lines', () => {
    expect(recognizeAgentCommandLine('vim src/index.ts')).toBeNull()
    expect(recognizeAgentCommandLine('pnpm test')).toBeNull()
    expect(recognizeAgentCommandLine('git commit -m "feat: new feature"')).toBeNull()
    expect(recognizeAgentCommandLine('echo agy')).toBeNull()
    expect(recognizeAgentCommandLine('cat agy.txt')).toBeNull()
    expect(recognizeAgentCommandLine('Terminal 1')).toBeNull()
  })

  it('filters by agentType when specified', () => {
    expect(isAgentCommandLineTitle("agy '--dangerously-s ~/C/orca", 'antigravity')).toBe(true)
    expect(isAgentCommandLineTitle("agy '--dangerously-s ~/C/orca", 'claude')).toBe(false)
    expect(isAgentCommandLineTitle('claude --dangerously-skip-permissions', 'claude')).toBe(true)
    expect(isAgentCommandLineTitle('claude --dangerously-skip-permissions', 'antigravity')).toBe(
      false
    )
  })
})
