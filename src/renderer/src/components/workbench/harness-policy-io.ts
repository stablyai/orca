import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { invokeNative } from '@/web/tauri-native-host'
import {
  createHarnessPolicyFromPreset,
  HARNESS_PRESETS,
  validateCommitMessage,
  type HarnessCommitStyle,
  type HarnessPolicy,
  type HarnessPolicyPresetId,
  type HarnessRuleMode
} from '../../../../shared/harness/harness-policy'

const LOCAL_STORAGE_KEY = 'orca.workbench.harnessPolicy.v1'
export const HARNESS_POLICY_REL_PATH = '.orca/harness.yml'

function normalizeMode(raw: unknown, fallback: HarnessRuleMode): HarnessRuleMode {
  return raw === 'block' || raw === 'warn' || raw === 'off' ? raw : fallback
}

function normalizeStyle(raw: unknown, fallback: HarnessCommitStyle): HarnessCommitStyle {
  return raw === 'off' || raw === 'conventional' || raw === 'google-cl' || raw === 'custom'
    ? raw
    : fallback
}

export function parseHarnessPolicyYaml(content: string): HarnessPolicy {
  const parsed: Record<string, unknown> | null = parseYaml(content)
  if (!parsed || typeof parsed !== 'object') {
    return createHarnessPolicyFromPreset('standard')
  }
  const rawPreset = parsed.preset
  const preset: HarnessPolicyPresetId =
    rawPreset === 'off' ||
    rawPreset === 'standard' ||
    rawPreset === 'google-cl' ||
    rawPreset === 'custom'
      ? rawPreset
      : 'custom'
  const base =
    preset !== 'custom'
      ? createHarnessPolicyFromPreset(preset)
      : createHarnessPolicyFromPreset('standard')
  base.preset = preset

  const rawRulesValue: unknown = parsed.rules
  const rawRules: Record<string, unknown> =
    rawRulesValue && typeof rawRulesValue === 'object'
      ? Object.fromEntries(Object.entries(rawRulesValue))
      : {}

  const commitFormatValue: unknown = rawRules.commitFormat
  const cf: Record<string, unknown> | undefined =
    commitFormatValue && typeof commitFormatValue === 'object'
      ? Object.fromEntries(Object.entries(commitFormatValue))
      : undefined
  if (cf) {
    base.rules.commitFormat = {
      mode: normalizeMode(cf.mode, base.rules.commitFormat.mode),
      style: normalizeStyle(cf.style, base.rules.commitFormat.style),
      maxSubjectLength:
        typeof cf.maxSubjectLength === 'number' && cf.maxSubjectLength > 0
          ? cf.maxSubjectLength
          : base.rules.commitFormat.maxSubjectLength,
      requireWhyBody:
        typeof cf.requireWhyBody === 'boolean'
          ? cf.requireWhyBody
          : base.rules.commitFormat.requireWhyBody,
      ...(typeof cf.customPattern === 'string' && cf.customPattern.trim()
        ? { customPattern: cf.customPattern.trim() }
        : {})
    }
  }

  const commitPerFeatureValue: unknown = rawRules.commitPerFeature
  const cpf: Record<string, unknown> | undefined =
    commitPerFeatureValue && typeof commitPerFeatureValue === 'object'
      ? Object.fromEntries(Object.entries(commitPerFeatureValue))
      : undefined
  if (cpf) {
    base.rules.commitPerFeature = {
      mode: normalizeMode(cpf.mode, base.rules.commitPerFeature.mode)
    }
  }

  const preCommitGateValue: unknown = rawRules.preCommitGate
  const pcg: Record<string, unknown> | undefined =
    preCommitGateValue && typeof preCommitGateValue === 'object'
      ? Object.fromEntries(Object.entries(preCommitGateValue))
      : undefined
  if (pcg) {
    base.rules.preCommitGate = {
      mode: normalizeMode(pcg.mode, base.rules.preCommitGate.mode),
      forbidNoVerify:
        typeof pcg.forbidNoVerify === 'boolean'
          ? pcg.forbidNoVerify
          : base.rules.preCommitGate.forbidNoVerify,
      commands: Array.isArray(pcg.commands)
        ? pcg.commands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : base.rules.preCommitGate.commands
    }
  }

  return base
}

export function serializeHarnessPolicyYaml(policy: HarnessPolicy): string {
  return stringifyYaml(policy)
}

export async function runCommitNodeHarnessCheck(
  targetDir: string,
  harnessPolicy: HarnessPolicy
): Promise<{ ok: boolean; error?: string; warnings: string[] }> {
  const warnings: string[] = []
  const gate = harnessPolicy.rules.preCommitGate
  if (gate.mode !== 'off') {
    for (const gateCmd of gate.commands) {
      const cmdRes = await invokeNative<{ passed: boolean; exitCode: number; output: string }>(
        'poc_run_workflow_command',
        { args: { workdir: targetDir, command: gateCmd } }
      )
      if (!cmdRes.passed) {
        const reason = `Pre-commit gate failed (${gateCmd}): ${cmdRes.output || `exit ${cmdRes.exitCode}`}`
        if (gate.mode === 'block') {
          return { ok: false, error: reason, warnings }
        }
        warnings.push(`[Harness warning] ${reason}`)
      }
    }
  }
  const logRes = await invokeNative<{ passed: boolean; exitCode: number; output: string }>(
    'poc_run_workflow_command',
    { args: { workdir: targetDir, command: 'git log -1 --pretty=%B' } }
  )
  if (logRes.passed && logRes.output.trim()) {
    const msgCheck = validateCommitMessage(logRes.output, harnessPolicy)
    if (!msgCheck.allowed) {
      return {
        ok: false,
        error: msgCheck.reason ?? 'Commit message rejected by harness.',
        warnings
      }
    }
    if (msgCheck.severity === 'warn' && msgCheck.reason) {
      warnings.push(`[Harness warning] ${msgCheck.reason}`)
    }
  }
  return { ok: true, warnings }
}

export async function loadHarnessPolicy(
  rootPath: string | null,
  connectionId?: string
): Promise<HarnessPolicy> {
  if (rootPath) {
    const filePath = `${rootPath.replace(/[\\/]+$/, '')}/${HARNESS_POLICY_REL_PATH}`
    try {
      const file = await window.api.fs.readFile({ filePath, connectionId })
      if (!file.isBinary && file.content.trim()) {
        return parseHarnessPolicyYaml(file.content)
      }
    } catch {
      // Fall through to local preference or default preset.
    }
  }
  try {
    const cached = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (cached) {
      return parseHarnessPolicyYaml(cached)
    }
  } catch {
    // Ignore storage read errors.
  }
  return structuredClone(HARNESS_PRESETS.standard)
}

export async function saveHarnessPolicy(
  policy: HarnessPolicy,
  rootPath: string | null,
  connectionId?: string
): Promise<string | null> {
  const yamlText = serializeHarnessPolicyYaml(policy)
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, yamlText)
  } catch {
    // Ignore storage quota errors.
  }
  if (!rootPath) {
    return null
  }
  const filePath = `${rootPath.replace(/[\\/]+$/, '')}/${HARNESS_POLICY_REL_PATH}`
  await window.api.fs.writeFile({ filePath, content: yamlText, connectionId })
  return filePath
}
