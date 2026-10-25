import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { buildAgentStartupPlan, agentPromptRidesLaunchCommand } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { recognizeAgentProcess } from './agent-process-recognition'

describe('ZCode orchestration and send-to-agent contract', () => {
  it('is dispatchable: its foreground process resolves back to the zcode agent', () => {
    // ZCode names its process zcode-cli; inject dispatch must recognize it.
    expect(TUI_AGENT_CONFIG.zcode.expectedProcess).toBe('zcode-cli')
    expect(recognizeAgentProcess('zcode-cli')?.agent).toBe('zcode')
  })

  it('has no session-option catalog, so worker --model is refused rather than swallowed', () => {
    // ZCode chooses models in its config/TUI and has no --model; a catalog would accept and silently drop the option.
    expect(getAgentSessionOptionCatalog('zcode')).toBeNull()
  })

  it("bypasses permissions with ZCode's own yolo mode, not a --yolo flag", () => {
    expect(YOLO_TUI_AGENT_ARGS.zcode).toBe('--mode yolo')
  })

  it('delivers prompts over stdin, never as argv', () => {
    // Positional prompts are parsed as subcommands; -p exits headlessly, so interactive prompts need stdin.
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
    expect(plan?.launchCommand).toBe("zcode '--mode' 'plan'")
  })

  it('waits for the composer instead of a quiet window before pasting a draft', () => {
    // The banner keeps repainting, so quiet-render readiness never settles; use the captured composer prompt.
    expect(TUI_AGENT_CONFIG.zcode.draftPasteReadySignal).toBe('zcode-composer-prompt')
  })
})
