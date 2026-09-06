import { describe, expect, it } from 'vitest'
import { tuiAgentToAgentKind } from './agent-kind'
import { detectAgentStatusFromTitle, getAgentLabel as getPrimaryAgentLabel } from './agent-detection'
import { isAtomCodeHeadlessOneShotCommand } from './atomcode-headless-command'
import { getAtomCodeTerminalTitleStatus } from './atomcode-terminal-title'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'
import {
  getAgentLabel as getCompatAgentLabel,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { TUI_AGENT_AUTO_PICK_ORDER } from './tui-agent-selection'

describe('AtomCode agent integration', () => {
  it('registers launch, display, permission, telemetry, and selection metadata', () => {
    expect(TUI_AGENT_CONFIG.atomcode).toMatchObject({
      detectCmd: 'atomcode',
      launchCmd: 'atomcode',
      expectedProcess: 'atomcode',
      promptInjectionMode: 'stdin-after-start'
    })
    expect(TUI_AGENT_DISPLAY_NAMES.atomcode).toBe('AtomCode')
    expect(YOLO_TUI_AGENT_ARGS.atomcode).toBe('--dangerously-skip-permissions')
    expect(tuiAgentToAgentKind('atomcode')).toBe('atomcode')
    expect(TUI_AGENT_AUTO_PICK_ORDER).toContain('atomcode')
  })

  it.each([
    ['🟢 AtomCode', 'idle'],
    ['🟡 Working on Codex compatibility', 'working'],
    ['🔴 Permission required', 'permission']
  ] as const)('recognizes %s as %s', (title, status) => {
    expect(getAtomCodeTerminalTitleStatus(title)).toBe(status)
    expect(detectAgentStatusFromTitle(title)).toBe(status)
    expect(getPrimaryAgentLabel(title)).toBe('AtomCode')
    expect(getCompatAgentLabel(title)).toBe('AtomCode')
    expect(resolveTerminalTitleAgentType(title)).toBe('atomcode')
  })

  it('publishes AtomCode identity from the vendor-owned traffic-light marker', () => {
    expect(collectAgentTitleEvidence('🟡 Review Codex behavior')).toMatchObject({
      agent: 'atomcode',
      reason: 'vendor-marker'
    })
    expect(resolvePublishedPaneAgentIdentity({ title: '🟢 Finished task' })).toBe('atomcode')
  })

  it('recognizes interactive processes but excludes prompt one-shots', () => {
    expect(recognizeAgentProcess('atomcode')).toEqual({ agent: 'atomcode', processName: 'atomcode' })
    expect(recognizeAgentProcessFromCommandLine('atomcode')).toEqual({
      agent: 'atomcode',
      processName: 'atomcode'
    })
    expect(recognizeAgentProcessFromCommandLine('atomcode -p hello')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('atomcode --prompt hello')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('atomcode --prompt-file task.md')).toBeNull()
  })

  it('recognizes all documented AtomCode prompt flag shapes as headless', () => {
    expect(isAtomCodeHeadlessOneShotCommand(['atomcode', '-p', 'hello'])).toBe(true)
    expect(isAtomCodeHeadlessOneShotCommand(['atomcode', '-phello'])).toBe(true)
    expect(isAtomCodeHeadlessOneShotCommand(['atomcode', '--prompt=hello'])).toBe(true)
    expect(isAtomCodeHeadlessOneShotCommand(['atomcode', '--prompt-file=task.md'])).toBe(true)
    expect(isAtomCodeHeadlessOneShotCommand(['atomcode'])).toBe(false)
  })

  it('does not infer AtomCode from path-like substring titles', () => {
    expect(getPrimaryAgentLabel('~/atomcode-project')).toBeNull()
    expect(getCompatAgentLabel('~/atomcode-project')).toBeNull()
    expect(collectAgentTitleEvidence('~/atomcode-project')).toMatchObject({
      agent: null,
      reason: 'no-evidence'
    })
  })
})
