import type { BrowserClientAutomationMethod } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR } from '../../../shared/browser/client-hosting/browser-client-file-channel-methods'
import type { AutomationCommandContext } from './tauri-native-browser-automation'
import { readNumber, readString, requireString } from './tauri-native-browser-automation'
import {
  checkAutomationElement,
  clickAutomationElement,
  dragAutomationElements,
  fillAutomationElement,
  focusAutomationElement,
  hoverAutomationElement,
  insertAutomationText,
  pressAutomationKey,
  scrollAutomationPage,
  scrollIntoViewAutomationElement,
  selectAllAutomationElement,
  selectAutomationElement
} from './tauri-native-browser-automation-interactions'
import {
  clickAutomationPointer,
  moveAutomationPointer,
  pressAutomationPointer,
  releaseAutomationPointer,
  wheelAutomationPointer
} from './tauri-native-browser-automation-pointer'
import { consoleAutomationLog, networkAutomationLog } from './tauri-native-browser-automation-logs'
import {
  captureAutomationStart,
  captureAutomationStop
} from './tauri-native-browser-automation-capture'
import { deviceAutomationSet } from './tauri-native-browser-automation-device'
import {
  interceptAutomationDisable,
  interceptAutomationEnable,
  interceptAutomationList
} from './tauri-native-browser-automation-intercept'
import {
  clipboardAutomationRead,
  clipboardAutomationWrite,
  dialogAutomationHandle,
  evalAutomationExpression,
  findAutomationText,
  getAutomationProperty,
  highlightAutomationSelector,
  isAutomationState,
  storageAutomationClear,
  storageAutomationGet,
  storageAutomationSet,
  waitAutomationCondition
} from './tauri-native-browser-automation-page-queries'
import {
  cookieAutomationDelete,
  cookieAutomationSet,
  cookiesAutomationGet,
  goBackAutomationPage,
  goForwardAutomationPage,
  gotoAutomationPage,
  pdfAutomationPage,
  proceedAutomationCertificate,
  reloadAutomationPage,
  screenshotAutomationPage
} from './tauri-native-browser-automation-page-state'
import {
  credentialsAutomationSet,
  geolocationAutomationSet,
  headersAutomationSet,
  mediaAutomationSet,
  offlineAutomationSet,
  viewportAutomationSet
} from './tauri-native-browser-automation-emulation'

function readElement(params: Record<string, unknown>): string {
  return requireString(params, 'element')
}

function automationUnavailable(): never {
  throw new Error('browser_command_unavailable')
}

export async function runTauriBrowserAutomationCommand(
  context: AutomationCommandContext,
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (method) {
    case 'browser.click':
      return clickAutomationElement(context, readElement(params), 1)
    case 'browser.dblclick':
      return clickAutomationElement(context, readElement(params), 2)
    case 'browser.goto':
      return gotoAutomationPage(context, requireString(params, 'url'))
    case 'browser.certificate.proceed':
      return proceedAutomationCertificate(context, params)
    case 'browser.fill':
      return fillAutomationElement(context, readElement(params), requireString(params, 'value'))
    case 'browser.type':
      return insertAutomationText(context, requireString(params, 'input'))
    case 'browser.keyboardInsertText': {
      await insertAutomationText(context, requireString(params, 'text'))
      return { inserted: true }
    }
    case 'browser.select': {
      const value = readString(params, 'value')
      if (value === undefined) {
        throw new Error('browser_invalid_params')
      }
      return selectAutomationElement(context, readElement(params), value)
    }
    case 'browser.scroll': {
      const direction = requireString(params, 'direction')
      return scrollAutomationPage(context, direction, readNumber(params, 'amount'))
    }
    case 'browser.back':
      return goBackAutomationPage(context)
    case 'browser.forward':
      return goForwardAutomationPage(context)
    case 'browser.reload':
      return reloadAutomationPage(context)
    case 'browser.screenshot':
      return screenshotAutomationPage(context, false, readString(params, 'format'))
    case 'browser.fullScreenshot':
      return screenshotAutomationPage(context, true, readString(params, 'format'))
    case 'browser.pdf':
      return pdfAutomationPage(context)
    case 'browser.console':
      return consoleAutomationLog(context, params)
    case 'browser.network':
      return networkAutomationLog(context, params)
    case 'browser.intercept.enable':
      return interceptAutomationEnable(context, params)
    case 'browser.intercept.disable':
      return interceptAutomationDisable(context)
    case 'browser.intercept.list':
      return interceptAutomationList(context)
    case 'browser.capture.start':
      return captureAutomationStart(context)
    case 'browser.capture.stop':
      return captureAutomationStop(context)
    case 'browser.setDevice':
      return deviceAutomationSet(context, params)
    case 'browser.eval':
      return evalAutomationExpression(context, requireString(params, 'expression'))
    case 'browser.hover':
      return hoverAutomationElement(context, readElement(params))
    case 'browser.drag':
      return dragAutomationElements(
        context,
        requireString(params, 'from'),
        requireString(params, 'to')
      )
    case 'browser.upload':
    case 'browser.download':
      throw new Error(BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR)
    case 'browser.wait':
      return waitAutomationCondition(context, params)
    case 'browser.check': {
      const checked = params.checked === undefined ? true : params.checked === true
      return checkAutomationElement(context, readElement(params), checked)
    }
    case 'browser.focus':
      return focusAutomationElement(context, readElement(params))
    case 'browser.clear':
      return fillAutomationElement(context, readElement(params), '')
    case 'browser.selectAll':
      return selectAllAutomationElement(context, readElement(params))
    case 'browser.keypress':
      return pressAutomationKey(context, requireString(params, 'key'))
    case 'browser.cookie.get':
      return cookiesAutomationGet(context, readString(params, 'url'))
    case 'browser.cookie.set':
      return cookieAutomationSet(context, params)
    case 'browser.cookie.delete':
      return cookieAutomationDelete(context, params)
    case 'browser.viewport':
      return viewportAutomationSet(context, params)
    case 'browser.geolocation':
      return geolocationAutomationSet(context, params)
    case 'browser.setOffline':
      return offlineAutomationSet(context, params)
    case 'browser.setHeaders':
      return headersAutomationSet(context, params)
    case 'browser.setMedia':
      return mediaAutomationSet(context, params)
    case 'browser.setCredentials':
      return credentialsAutomationSet(context, params)
    case 'browser.clipboardRead':
      return clipboardAutomationRead(context)
    case 'browser.clipboardWrite':
      return clipboardAutomationWrite(context, requireString(params, 'text'))
    case 'browser.dialogAccept':
      return dialogAutomationHandle(context, true, readString(params, 'text'))
    case 'browser.dialogDismiss':
      return dialogAutomationHandle(context, false)
    case 'browser.storage.local.get':
      return storageAutomationGet(context, 'local', readString(params, 'key'))
    case 'browser.storage.local.set':
      return storageAutomationSet(
        context,
        'local',
        requireString(params, 'key'),
        requireString(params, 'value')
      )
    case 'browser.storage.local.clear':
      return storageAutomationClear(context, 'local')
    case 'browser.storage.session.get':
      return storageAutomationGet(context, 'session', readString(params, 'key'))
    case 'browser.storage.session.set':
      return storageAutomationSet(
        context,
        'session',
        requireString(params, 'key'),
        requireString(params, 'value')
      )
    case 'browser.storage.session.clear':
      return storageAutomationClear(context, 'session')
    case 'browser.find':
      return findAutomationText(
        context,
        requireString(params, 'locator'),
        requireString(params, 'value')
      )
    case 'browser.get':
      return getAutomationProperty(
        context,
        requireString(params, 'what'),
        readString(params, 'selector')
      )
    case 'browser.is':
      return isAutomationState(
        context,
        requireString(params, 'what'),
        requireString(params, 'selector')
      )
    case 'browser.highlight':
      return highlightAutomationSelector(context, requireString(params, 'selector'))
    case 'browser.mouseMove':
      return moveAutomationPointer(context, params)
    case 'browser.mouseDown':
      return pressAutomationPointer(context, params)
    case 'browser.mouseClick':
      return clickAutomationPointer(context, params)
    case 'browser.mouseUp':
      return releaseAutomationPointer(context, params)
    case 'browser.mouseWheel':
      return wheelAutomationPointer(context, params)
    case 'browser.scrollIntoView':
      return scrollIntoViewAutomationElement(context, readElement(params))
    case 'browser.snapshot':
    case 'browser.exec':
      return automationUnavailable()
  }
}
