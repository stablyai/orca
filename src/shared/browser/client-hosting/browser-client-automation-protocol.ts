import { z } from 'zod'
import { BrowserExpectedUrlMismatch } from './browser-expected-url'

export const BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY = 'automation-v1' as const
// Older hosts re-parse params and would drop expectUrl, so commands carrying it need this.
export const BROWSER_CLIENT_EXPECT_URL_HOST_CAPABILITY = 'expect-url-v1' as const
export const BROWSER_CLIENT_AUTOMATION_PARAMS_MAX_BYTES = 256 * 1024
// Why: sized to a host's 1 MiB inbound frame, which sealing inflates by 4/3.
export const BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES = 768 * 1024
// Larger results travel ahead of their settlement in chunks; base64 keeps each chunk inside one frame.
export const BROWSER_CLIENT_AUTOMATION_RESULT_CHUNK_MAX_BYTES = 512 * 1024
export const BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES = 64 * 1024 * 1024
export const BROWSER_CLIENT_HOST_COMMAND_RESULT_CHUNK_METHOD =
  'browser.clientHost.commandResultChunk' as const
const BROWSER_CLIENT_AUTOMATION_ERROR_MESSAGE_MAX_LENGTH = 4096

export const BROWSER_CLIENT_AUTOMATION_METHODS = [
  'browser.snapshot',
  'browser.click',
  'browser.goto',
  'browser.certificate.proceed',
  'browser.fill',
  'browser.type',
  'browser.keyboardInsertText',
  'browser.select',
  'browser.scroll',
  'browser.back',
  'browser.reload',
  'browser.screenshot',
  'browser.eval',
  'browser.hover',
  'browser.drag',
  'browser.upload',
  'browser.wait',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.selectAll',
  'browser.keypress',
  'browser.pdf',
  'browser.fullScreenshot',
  'browser.cookie.get',
  'browser.cookie.set',
  'browser.cookie.delete',
  'browser.viewport',
  'browser.geolocation',
  'browser.intercept.enable',
  'browser.intercept.disable',
  'browser.intercept.list',
  'browser.capture.start',
  'browser.capture.stop',
  'browser.console',
  'browser.network',
  'browser.dblclick',
  'browser.forward',
  'browser.scrollIntoView',
  'browser.get',
  'browser.is',
  'browser.mouseMove',
  'browser.mouseDown',
  'browser.mouseClick',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.find',
  'browser.setDevice',
  'browser.setOffline',
  'browser.setHeaders',
  'browser.setCredentials',
  'browser.setMedia',
  'browser.clipboardRead',
  'browser.clipboardWrite',
  'browser.dialogAccept',
  'browser.dialogDismiss',
  'browser.storage.local.get',
  'browser.storage.local.set',
  'browser.storage.local.clear',
  'browser.storage.session.get',
  'browser.storage.session.set',
  'browser.storage.session.clear',
  'browser.download',
  'browser.highlight',
  'browser.exec'
] as const

export const BrowserClientAutomationMethod = z.enum(BROWSER_CLIENT_AUTOMATION_METHODS)
export type BrowserClientAutomationMethod = z.infer<typeof BrowserClientAutomationMethod>

const BrowserClientAutomationParams = z
  .record(z.string(), z.unknown())
  .superRefine((params, context) =>
    enforceJsonByteBudget(
      params,
      BROWSER_CLIENT_AUTOMATION_PARAMS_MAX_BYTES,
      'Browser client automation params exceed their byte budget',
      context
    )
  )

const BrowserClientAutomationResultValue = z
  .unknown()
  .superRefine((value, context) =>
    enforceJsonByteBudget(
      value,
      BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES,
      'Browser client automation result exceeds its byte budget',
      context
    )
  )

export const BrowserClientAutomationCommand = z.object({
  type: z.literal('automation'),
  method: BrowserClientAutomationMethod,
  params: BrowserClientAutomationParams,
  /** The host's caller was an agent's CLI; older hosts omit it and every command counts as one. */
  agent: z.boolean().optional(),
  /** The host assembles results sent as chunks; older hosts omit it and refuse results over one frame. */
  stagedResults: z.literal(true).optional()
})
export type BrowserClientAutomationCommand = z.infer<typeof BrowserClientAutomationCommand>

export const BrowserClientAutomationResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    value: BrowserClientAutomationResultValue.optional(),
    /** The value's JSON byte length, already sent as chunks; replaces `value`. */
    stagedValueBytes: z
      .number()
      .int()
      .positive()
      .max(BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES)
      .optional()
  }),
  z.object({
    status: z.literal('failed'),
    errorCode: z.string().min(1).max(256),
    errorMessage: z
      .string()
      .min(1)
      .max(BROWSER_CLIENT_AUTOMATION_ERROR_MESSAGE_MAX_LENGTH)
      .optional(),
    expectedUrlMismatch: BrowserExpectedUrlMismatch.optional()
  })
])
export type BrowserClientAutomationResult = z.infer<typeof BrowserClientAutomationResult>

export function truncateBrowserClientAutomationErrorMessage(message: string): string | undefined {
  return message.length > 0
    ? message.slice(0, BROWSER_CLIENT_AUTOMATION_ERROR_MESSAGE_MAX_LENGTH)
    : undefined
}

function enforceJsonByteBudget(
  value: unknown,
  maxBytes: number,
  message: string,
  context: z.core.$RefinementCtx<unknown>
): void {
  let bytes = Number.POSITIVE_INFINITY
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {}
  if (bytes > maxBytes) {
    context.addIssue({ code: 'custom', message })
  }
}
