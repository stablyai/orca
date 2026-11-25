import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { sanitizeCrashReportString } from '../../crash-reporting/crash-report-redaction'
import {
  AUTOMATION_RUN_FAILURE_COPY,
  type AutomationRunFailure
} from './automation-run-failure-copy'

/** Bounds the provider-derived model name a run record keeps. */
function automationRunModelParam(model: string): string {
  return sanitizeCrashReportString(model)
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 120)
}

/** The run's agent could not use its model. `agent` only when the run's own agent is known. */
export function isFailedAutomationRunModel(
  model: string,
  params: AutomationRunFailure['errorParams']
): boolean {
  // Older history only has the display value. A collision cannot be disambiguated there.
  return (
    matchesAutomationRunModelFingerprint(model, params) ??
    (typeof params?.model === 'string' && params.model === automationRunModelParam(model))
  )
}

export function matchesAutomationRunModelFingerprint(
  model: string,
  params: AutomationRunFailure['errorParams']
): boolean | undefined {
  const fingerprint = params?.modelFingerprint
  return typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint)
    ? fingerprint === automationModelFingerprint(model)
    : undefined
}

function automationModelFingerprint(model: string): string {
  return bytesToHex(sha256(JSON.stringify(model)))
}

export function automationRunModelUnavailable({
  agent,
  agentLabel,
  model,
  launchModel
}: {
  agent?: string
  agentLabel?: string
  model?: string
  launchModel?: string
}): AutomationRunFailure {
  const bounded = model ? automationRunModelParam(model) : ''
  const EN = AUTOMATION_RUN_FAILURE_COPY
  return {
    error: EN.agentModelUnavailable
      .replace('{{agent}}', () => agentLabel ?? EN.theAgent)
      .replace('{{model}}', () => bounded || EN.selectedModel),
    errorCode: 'agentModelUnavailable',
    errorParams: {
      ...(agent ? { agent } : {}),
      ...(bounded ? { model: bounded } : {}),
      ...(launchModel ? { modelFingerprint: automationModelFingerprint(launchModel) } : {})
    }
  }
}
