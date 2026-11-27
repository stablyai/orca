import type { BrowserPagePromptKind } from '../../../../../shared/browser/prompts/browser-page-prompt'
import type { BrowserPagePromptHandler } from './browser-page-prompts'
import { externalAppPrompt } from './browser-external-app-prompt'
import { httpAuthPrompt } from './browser-http-auth-prompt'
import { javaScriptDialogPrompt } from './browser-javascript-dialog-prompt'
import { sitePermissionPrompt } from './browser-site-permission-prompt'

export const BROWSER_PAGE_PROMPT_HANDLERS: {
  [K in BrowserPagePromptKind]: BrowserPagePromptHandler<K>
} = {
  'external-app': externalAppPrompt,
  'http-auth': httpAuthPrompt,
  'javascript-dialog': javaScriptDialogPrompt,
  'site-permission': sitePermissionPrompt
}
