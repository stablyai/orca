export type HarnessRuleMode = 'block' | 'warn' | 'off'
export type HarnessCommitStyle = 'off' | 'conventional' | 'google-cl' | 'custom'
export type HarnessPolicyPresetId = 'off' | 'standard' | 'google-cl' | 'custom'

export type HarnessPolicy = {
  preset: HarnessPolicyPresetId
  rules: {
    commitFormat: {
      mode: HarnessRuleMode
      style: HarnessCommitStyle
      maxSubjectLength: number
      requireWhyBody: boolean
      customPattern?: string
    }
    commitPerFeature: {
      mode: HarnessRuleMode
    }
    preCommitGate: {
      mode: HarnessRuleMode
      forbidNoVerify: boolean
      commands: string[]
    }
  }
}

export type HarnessCheckResult = {
  allowed: boolean
  severity: 'pass' | 'warn' | 'block'
  ruleId: string
  reason?: string
}

export const HARNESS_PRESETS: Record<Exclude<HarnessPolicyPresetId, 'custom'>, HarnessPolicy> = {
  off: {
    preset: 'off',
    rules: {
      commitFormat: {
        mode: 'off',
        style: 'off',
        maxSubjectLength: 72,
        requireWhyBody: false
      },
      commitPerFeature: { mode: 'off' },
      preCommitGate: { mode: 'off', forbidNoVerify: false, commands: [] }
    }
  },
  standard: {
    preset: 'standard',
    rules: {
      commitFormat: {
        mode: 'warn',
        style: 'conventional',
        maxSubjectLength: 72,
        requireWhyBody: false
      },
      commitPerFeature: { mode: 'warn' },
      preCommitGate: { mode: 'block', forbidNoVerify: true, commands: [] }
    }
  },
  'google-cl': {
    preset: 'google-cl',
    rules: {
      commitFormat: {
        mode: 'block',
        style: 'google-cl',
        maxSubjectLength: 72,
        requireWhyBody: true
      },
      commitPerFeature: { mode: 'block' },
      preCommitGate: {
        mode: 'block',
        forbidNoVerify: true,
        commands: ['pnpm exec oxlint', 'pnpm tc:web']
      }
    }
  }
}

export function createHarnessPolicyFromPreset(
  preset: Exclude<HarnessPolicyPresetId, 'custom'>
): HarnessPolicy {
  return structuredClone(HARNESS_PRESETS[preset])
}

const CONVENTIONAL_RE = /^[a-z]+(\([a-z0-9._/-]+\))?!?:\s+\S/
const WIP_RE = /^(wip|tmp|fixup!|squash!)\b/i

export function validateCommitMessage(message: string, policy: HarnessPolicy): HarnessCheckResult {
  const rule = policy.rules.commitFormat
  if (rule.mode === 'off' || rule.style === 'off') {
    return { allowed: true, severity: 'pass', ruleId: 'commitFormat' }
  }

  const lines = message.trim().split(/\r?\n/)
  const subject = lines[0]?.trim() ?? ''
  const body = lines.slice(1).join('\n').trim()

  const fail = (reason: string): HarnessCheckResult => ({
    allowed: rule.mode !== 'block',
    severity: rule.mode === 'block' ? 'block' : 'warn',
    ruleId: 'commitFormat',
    reason
  })

  if (!subject) {
    return fail('Commit subject cannot be empty.')
  }
  if (WIP_RE.test(subject)) {
    return fail('WIP/fixup commit subjects are disallowed by harness policy.')
  }
  if (subject.length > rule.maxSubjectLength) {
    return fail(`Subject exceeds ${rule.maxSubjectLength} characters (${subject.length}).`)
  }
  if (rule.style === 'conventional' && !CONVENTIONAL_RE.test(subject)) {
    return fail('Subject must follow Conventional Commits (e.g. feat(scope): summary).')
  }
  if (rule.style === 'google-cl') {
    if (subject.endsWith('.')) {
      return fail('Google CL subject line must not end with a trailing period.')
    }
    if (rule.requireWhyBody && body.length === 0) {
      return fail('Google CL requires a body explaining why the change is needed.')
    }
  }
  if (rule.style === 'custom' && rule.customPattern) {
    try {
      const re = new RegExp(rule.customPattern)
      if (!re.test(subject)) {
        return fail(`Subject does not match custom pattern: ${rule.customPattern}`)
      }
    } catch {
      return fail(`Invalid custom commit regex: ${rule.customPattern}`)
    }
  }

  return { allowed: true, severity: 'pass', ruleId: 'commitFormat' }
}

export function checkToolCommandAllowed(
  command: string,
  policy: HarnessPolicy
): HarnessCheckResult {
  const gate = policy.rules.preCommitGate
  if (gate.mode === 'off' || !gate.forbidNoVerify) {
    return { allowed: true, severity: 'pass', ruleId: 'preCommitGate.noVerify' }
  }
  if (/\bgit\s+(commit|push)\b/i.test(command) && /(^|\s)(--no-verify|-n)(\s|$)/.test(command)) {
    return {
      allowed: gate.mode !== 'block',
      severity: gate.mode === 'block' ? 'block' : 'warn',
      ruleId: 'preCommitGate.noVerify',
      reason: 'Bypassing git hooks with --no-verify is blocked by harness policy.'
    }
  }
  return { allowed: true, severity: 'pass', ruleId: 'preCommitGate.noVerify' }
}

export function evaluateCompletionGate(
  hasDirtyFiles: boolean,
  policy: HarnessPolicy
): HarnessCheckResult {
  const rule = policy.rules.commitPerFeature
  if (rule.mode === 'off' || !hasDirtyFiles) {
    return { allowed: true, severity: 'pass', ruleId: 'commitPerFeature' }
  }
  return {
    allowed: rule.mode !== 'block',
    severity: rule.mode === 'block' ? 'block' : 'warn',
    ruleId: 'commitPerFeature',
    reason: 'Uncommitted changes remain in worktree; commit completed feature before finishing.'
  }
}
