import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { buildAgentStartupPlan, agentPromptRidesLaunchCommand } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { recognizeAgentProcess } from './agent-process-recognition'

describe('ZCode orchestration and send-to-agent contract', () => {
  it('is dispatchable: its foreground process resolves back to the zcode agent', () => {
    // Why this matters: ZCode sets `process.title = 'zcode-cli'`, so without this mapping
    // `dispatch --inject` refuses the pane with no_agent_detected.
    expect(TUI_AGENT_CONFIG.zcode.expectedProcess).toBe('zcode-cli')
    expect(recognizeAgentProcess('zcode-cli')?.agent).toBe('zcode')
  })

  it('has no session-option catalog, so worker --model is refused rather than swallowed', () => {
    // Why: ZCode's CLI exposes no `--model` flag at all — the model comes from its own
    // config and its in-TUI picker. Same position as opencode: a catalog here would accept
    // `--model` and then silently drop it, which is worse than a clear refusal.
    expect(getAgentSessionOptionCatalog('zcode')).toBeNull()
  })

  it("bypasses permissions with ZCode's own yolo mode, not a --yolo flag", () => {
    expect(YOLO_TUI_AGENT_ARGS.zcode).toBe('--mode yolo')
  })

  it('delivers prompts over stdin, never as argv', () => {
    // Why: ZCode reads positionals[0] as a SUBCOMMAND, so an argv prompt exits with
    // "Unknown command"; `-p` is headless-only and quits after one turn.
    expect(TUI_AGENT_CONFIG.zcode.promptInjectionMode).toBe('stdin-after-start')
    expect(agentPromptRidesLaunchCommand('zcode')).toBe(false)
  })

  it('keeps the prompt out of the launch command and hands it back as a follow-up', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'refactor the parser',
      cmdOverrides: {},
      platform: 'darwin'
    })
    expect(plan?.launchCommand).toBe('zcode')
    expect(plan?.launchCommand).not.toContain('refactor the parser')
    expect(plan?.followupPrompt).toBe('refactor the parser')
  })

  it('carries a mode chosen through agent args onto the launch command', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      allowEmptyPromptLaunch: true,
      agentArgs: '--mode plan'
    })
    // Args are shell-quoted into the launch command, so assert the quoted form.
    expect(plan?.launchCommand).toBe("zcode '--mode' 'plan'")
  })

  it('waits for the composer instead of a quiet window before pasting a draft', () => {
    // Why: ZCode repaints its ASCII banner forever, so the default quiet-render window
    // never settles — see zcode-readiness-transcript.test.ts for the captured evidence.
    expect(TUI_AGENT_CONFIG.zcode.draftPasteReadySignal).toBe('zcode-composer-prompt')
  })
})
