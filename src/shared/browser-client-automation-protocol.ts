import { z } from 'zod'

export const BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY = 'automation-v1' as const
export const BROWSER_CLIENT_AUTOMATION_PARAMS_MAX_BYTES = 256 * 1024
export const BROWSER_CLIENT_AUTOMATION_RESULT_MAX_BYTES = 768 * 1024

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
  params: BrowserClientAutomationParams
})
export type BrowserClientAutomationCommand = z.infer<typeof BrowserClientAutomationCommand>

export const BrowserClientAutomationResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    value: BrowserClientAutomationResultValue.optional()
  }),
  z.object({ status: z.literal('failed'), errorCode: z.string().min(1).max(256) })
])
export type BrowserClientAutomationResult = z.infer<typeof BrowserClientAutomationResult>

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
