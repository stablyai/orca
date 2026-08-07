import { lazyWithRetry } from '@/lib/lazy-with-retry'

// Why: the inline terminal drags the whole xterm graph (~1.8MB chunk) into the
// renderer's eager modulepreload set, where V8 compiles it before
// did-finish-load even when no call site renders it.
const importInlineCommandTerminal = () =>
  import('./OnboardingInlineCommandTerminal').then((module) => ({
    default: module.OnboardingInlineCommandTerminal
  }))

// One binding per call site: same chunk, distinct reloadKey so a chunk failure
// still names the surface it broke.
export const AgentSkillSetupInlineCommandTerminal = lazyWithRetry(importInlineCommandTerminal, {
  reloadKey: 'agent-skill-setup-terminal'
})
export const CliSkillSetupInlineCommandTerminal = lazyWithRetry(importInlineCommandTerminal, {
  reloadKey: 'cli-skill-setup-terminal'
})
