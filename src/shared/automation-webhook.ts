import type {
  Automation,
  AutomationRun,
  AutomationWebhookConfig,
  AutomationWebhookDelivery,
  AutomationWebhookSecretMode
} from './automations-types'

/** Cap stored webhook bodies so a large payload cannot bloat the persisted
 *  run state or the agent prompt. Bodies above this are truncated and flagged. */
export const MAX_WEBHOOK_BODY_CHARS = 64 * 1024

/** Cap the stored content-type so a padded header cannot bloat the run record. */
export const MAX_WEBHOOK_CONTENT_TYPE_CHARS = 256

const SECRET_MODES: readonly AutomationWebhookSecretMode[] = ['none', 'token', 'hmac_sha256']

function isSecretMode(value: unknown): value is AutomationWebhookSecretMode {
  return typeof value === 'string' && SECRET_MODES.includes(value as AutomationWebhookSecretMode)
}

/** Normalize untrusted webhook config from create/update inputs into a stored
 *  shape, or null when webhooks are not configured. A 'none' secret mode drops
 *  any secret; 'token'/'hmac_sha256' without a secret fall back to 'none' so a
 *  half-configured automation never claims to verify when it cannot. */
export function normalizeAutomationWebhookConfig(
  input: AutomationWebhookConfig | null | undefined
): AutomationWebhookConfig | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const enabled = input.enabled === true
  const secretMode = isSecretMode(input.secretMode) ? input.secretMode : 'none'
  const secretRaw = typeof input.secret === 'string' ? input.secret.trim() : ''
  if (secretMode === 'none' || secretRaw.length === 0) {
    return { enabled, secretMode: 'none', secret: null }
  }
  return { enabled, secretMode, secret: secretRaw }
}

/** True when the automation has a webhook trigger turned on. */
export function isWebhookTriggerEnabled(automation: Pick<Automation, 'webhook'>): boolean {
  return automation.webhook?.enabled === true
}

/** Capture an inbound request body into a size-capped delivery record. */
export function captureWebhookDelivery(args: {
  body: string
  contentType: string | null
  receivedAt: number
}): AutomationWebhookDelivery {
  const truncated = args.body.length > MAX_WEBHOOK_BODY_CHARS
  const contentType =
    args.contentType !== null ? args.contentType.slice(0, MAX_WEBHOOK_CONTENT_TYPE_CHARS) : null
  return {
    body: truncated ? args.body.slice(0, MAX_WEBHOOK_BODY_CHARS) : args.body,
    contentType,
    truncated,
    receivedAt: args.receivedAt
  }
}

/** Compose the prompt actually sent to the agent for a run: the automation's
 *  own prompt, plus the raw webhook body appended as additional context when
 *  the run was webhook-triggered. Generic by design — no provider-specific
 *  field parsing (issue #2). Used by both the renderer and headless dispatch
 *  paths so the two stay in sync. */
export function composeAutomationDispatchPrompt(
  automation: Pick<Automation, 'prompt'>,
  run: Pick<AutomationRun, 'id' | 'webhookDelivery'>
): string {
  const delivery = run.webhookDelivery
  if (!delivery || delivery.body.length === 0) {
    return automation.prompt
  }
  const base = automation.prompt.replace(/\s+$/, '')
  // Why: the body is UNTRUSTED, attacker-controlled content. Fence it with an
  // unguessable per-run boundary (the server-generated run id) so the payload
  // cannot close the wrapper tag early and inject instructions into the prompt.
  const boundary = `webhook-payload-${run.id}`
  const truncatedNote = delivery.truncated ? ' truncated="true"' : ''
  const block = `<${boundary}${truncatedNote}>\n${delivery.body}\n</${boundary}>`
  return base.length > 0 ? `${base}\n\n${block}` : block
}
