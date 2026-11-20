import type { z } from 'zod'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResultParams,
  BrowserHostLeaseAuthority
} from '../../../shared/browser/client-hosting/browser-client-host-protocol'

type BrowserClientHostCommandResult = z.infer<typeof BrowserClientHostCommandResultParams>['result']
import {
  BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR,
  requiresBrowserClientFileChannel
} from '../../../shared/browser/client-hosting/browser-client-file-channel-methods'
import { invokeNative } from './tauri-native-host'
import {
  ensureTauriBrowserAutomationContext,
  executeTauriBrowserClientAutomation,
  retireTauriBrowserClientAutomation
} from './tauri-native-browser-automation'
import {
  downloadTauriBrowserFile,
  uploadTauriBrowserFiles
} from './tauri-native-browser-automation-transfers'
import { getTauriBrowserFileChannelClient } from './tauri-native-browser-file-channel'
import { tauriBrowserClientPageRendererBus } from './tauri-native-browser-client-page-renderer-bus'
import {
  noteTauriBrowserClientRouteAuthority,
  resolveTauriBrowserClientPartition
} from './tauri-native-browser-client-route-partition'
import type { TauriBrowserHostClient } from './tauri-native-browser-client-host'

// Page-command execution for the Tauri client host: pages mount, navigate,
// and close in native child webviews through the renderer request bus, and
// results report back on the host lease like Electron's main does.
// The registry and lease lifecycle stay in tauri-native-browser-client-host.

export type HostedPage = {
  pageHostGeneration: number
  partition: string
  browserProfileId: string
  executionHostKey: string
  workspaceId?: string
  currentUrl?: string
}

export type HostRecord = {
  environmentId: string
  authorityRuntimeId: string
  authority: BrowserHostLeaseAuthority | null
  browserHostClientId: string
  pages: Map<string, HostedPage>
  subscription: { unsubscribe: () => void } | null
  abort: AbortController | null
  ready: Promise<BrowserHostLeaseAuthority> | null
  closed: boolean
  handling: Map<string, Promise<void>>
}

export async function sendTauriBrowserClientHostCommandResult(
  client: TauriBrowserHostClient,
  event: BrowserClientHostCommandEvent,
  result: BrowserClientHostCommandResult
): Promise<void> {
  try {
    await client.call(
      'browser.clientHost.commandResult',
      {
        authorityRuntimeId: event.authorityRuntimeId,
        authorityEpoch: event.authorityEpoch,
        browserHostClientId: event.browserHostClientId,
        browserHostGeneration: event.browserHostGeneration,
        pageCommandProtocolVersion: event.pageCommandProtocolVersion,
        browserPageId: event.browserPageId,
        pageHostGeneration: event.pageHostGeneration,
        commandSequence: event.commandSequence,
        commandId: event.commandId,
        result
      },
      { timeoutMs: 15_000 }
    )
  } catch {
    // The runtime fences stale commands itself; a lost result only strands one page.
  }
}

export async function executeTauriBrowserClientHostPageCommand(
  record: HostRecord,
  event: BrowserClientHostCommandEvent
): Promise<BrowserClientHostCommandResult> {
  try {
    switch (event.command.type) {
      case 'createPage':
      case 'restorePage': {
        const partition = await resolveTauriBrowserClientPartition(
          record.environmentId,
          event.command.browserProfileId,
          event.command.executionHostKey
        )
        const outcome = await tauriBrowserClientPageRendererBus.request({
          type: 'mountPage',
          page: {
            partition,
            browserPageId: event.browserPageId,
            pageHostGeneration: event.pageHostGeneration
          }
        })
        if (outcome.type !== 'mounted') {
          return {
            status: 'failed',
            errorCode:
              outcome.type === 'failed' ? outcome.errorCode : 'browser_client_page_mount_unexpected'
          }
        }
        record.pages.set(event.browserPageId, {
          pageHostGeneration: event.pageHostGeneration,
          partition,
          browserProfileId: event.command.browserProfileId,
          executionHostKey: event.command.executionHostKey,
          ...(event.command.workspaceId ? { workspaceId: event.command.workspaceId } : {}),
          ...(event.command.type === 'restorePage' && event.command.url
            ? { currentUrl: event.command.url }
            : {})
        })
        if (event.command.type === 'restorePage' && event.command.url) {
          await invokeNative('poc_browser_navigate', {
            args: { browserPageId: event.browserPageId, url: event.command.url }
          })
          record.pages.get(event.browserPageId)!.currentUrl = event.command.url
        }
        if (record.authority) {
          noteTauriBrowserClientRouteAuthority(
            record.environmentId,
            record.authority,
            event.command.executionHostKey
          )
        }
        return { status: 'completed' }
      }
      case 'navigate': {
        await invokeNative('poc_browser_navigate', {
          args: { browserPageId: event.browserPageId, url: event.command.url }
        })
        const page = record.pages.get(event.browserPageId)
        if (page) {
          page.currentUrl = event.command.url
        }
        return { status: 'completed' }
      }
      case 'closePage': {
        const page = record.pages.get(event.browserPageId)
        if (page) {
          await tauriBrowserClientPageRendererBus.request({
            type: 'retirePage',
            page: {
              partition: page.partition,
              browserPageId: event.browserPageId,
              pageHostGeneration: page.pageHostGeneration
            }
          })
          retireTauriBrowserClientAutomation(event.browserPageId, page.pageHostGeneration)
          record.pages.delete(event.browserPageId)
        } else {
          await invokeNative('poc_browser_close', {
            args: { browserPageId: event.browserPageId }
          }).catch(() => {})
          retireTauriBrowserClientAutomation(event.browserPageId)
        }
        return { status: 'completed' }
      }
      case 'reclaimPage': {
        const page = record.pages.get(event.browserPageId)
        if (!page) {
          return {
            status: 'failed',
            errorCode: 'browser_client_page_reconciliation_authority_stale'
          }
        }
        const nextPartition = await resolveTauriBrowserClientPartition(
          record.environmentId,
          event.command.browserProfileId,
          event.command.executionHostKey
        )
        const outcome = await tauriBrowserClientPageRendererBus.request({
          type: 'rekeyPage',
          page: {
            partition: page.partition,
            browserPageId: event.browserPageId,
            pageHostGeneration: page.pageHostGeneration
          },
          nextPage: {
            partition: nextPartition,
            browserPageId: event.browserPageId,
            pageHostGeneration: event.pageHostGeneration
          }
        })
        if (outcome.type !== 'rekeyed') {
          return {
            status: 'failed',
            errorCode:
              outcome.type === 'failed' ? outcome.errorCode : 'browser_client_page_rekey_unexpected'
          }
        }
        record.pages.set(event.browserPageId, {
          pageHostGeneration: event.pageHostGeneration,
          partition: nextPartition,
          browserProfileId: event.command.browserProfileId,
          executionHostKey: event.command.executionHostKey,
          ...(event.command.workspaceId ? { workspaceId: event.command.workspaceId } : {}),
          ...(page.currentUrl ? { currentUrl: page.currentUrl } : {})
        })
        if (record.authority) {
          noteTauriBrowserClientRouteAuthority(
            record.environmentId,
            record.authority,
            event.command.executionHostKey
          )
        }
        return { status: 'completed' }
      }
      case 'automation': {
        if (requiresBrowserClientFileChannel(event.command.method)) {
          const channelClient = getTauriBrowserFileChannelClient(record.environmentId)
          const authority = record.authority
          if (!channelClient || !authority) {
            return { status: 'failed', errorCode: BROWSER_CLIENT_FILE_CHANNEL_REQUIRED_ERROR }
          }
          try {
            const route = {
              authority,
              browserPageId: event.browserPageId,
              pageHostGeneration: event.pageHostGeneration
            }
            const context = await ensureTauriBrowserAutomationContext(
              event.browserPageId,
              event.pageHostGeneration
            )
            if (event.command.method === 'browser.upload') {
              const files = event.command.params.files
              const element =
                typeof event.command.params.element === 'string' ? event.command.params.element : ''
              const value = await uploadTauriBrowserFiles(
                channelClient,
                route,
                context,
                element,
                files
              )
              return { status: 'completed', value }
            }
            const selector =
              typeof event.command.params.selector === 'string' ? event.command.params.selector : ''
            const value = await downloadTauriBrowserFile(
              channelClient,
              route,
              context.send,
              selector,
              event.command.params.path
            )
            return { status: 'completed', value }
          } catch (error) {
            return {
              status: 'failed',
              errorCode:
                error instanceof Error ? error.message : 'browser_client_page_command_failed'
            }
          }
        }
        try {
          const value = await executeTauriBrowserClientAutomation(
            event.browserPageId,
            event.pageHostGeneration,
            event.command.method,
            event.command.params
          )
          const page = record.pages.get(event.browserPageId)
          if (
            page &&
            (event.command.method === 'browser.goto' ||
              event.command.method === 'browser.back' ||
              event.command.method === 'browser.forward' ||
              event.command.method === 'browser.reload') &&
            typeof value === 'object' &&
            value !== null &&
            'url' in value &&
            typeof value.url === 'string'
          ) {
            page.currentUrl = value.url
          }
          return { status: 'completed', value }
        } catch (error) {
          return {
            status: 'failed',
            errorCode: error instanceof Error ? error.message : 'browser_client_page_command_failed'
          }
        }
      }
    }
  } catch (error) {
    return {
      status: 'failed',
      errorCode: error instanceof Error ? error.message : 'browser_client_page_command_failed'
    }
  }
  return { status: 'failed', errorCode: 'browser_client_page_command_unhandled' }
}
