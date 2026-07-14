import type React from 'react'
import { useEffect, useState } from 'react'
import { Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import type {
  ChatImportBrowserId,
  ChatImportBrowserStatus,
  ChatImportSetupStatus
} from '../../../../preload/api-types'
import {
  IntegrationStatusPill,
  type IntegrationStatusTone
} from '@/components/integration-status-pill'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type ChatImportSource = keyof ChatImportSetupStatus['lastSyncedBySource']

// Brand labels for the three web-chat sources; these mirror the web-agent
// display names (ChatGPT / Claude.ai / Gemini) and aren't localized.
const SOURCE_LABELS: Record<ChatImportSource, string> = {
  CHATGPT: 'ChatGPT',
  CLAUDE: 'Claude.ai',
  GEMINI: 'Gemini'
}

const SOURCE_ORDER: ChatImportSource[] = ['CHATGPT', 'CLAUDE', 'GEMINI']

export function WebChatBrowserLinkSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<ChatImportSetupStatus | null>(null)
  const [installing, setInstalling] = useState<ChatImportBrowserId | null>(null)

  useEffect(() => {
    // Guard against a setState after unmount if the status load resolves late.
    let active = true
    void window.api.chatImportSetup.getStatus().then((next) => {
      if (active) {
        setStatus(next)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const refreshStatus = async (): Promise<void> => {
    const next = await window.api.chatImportSetup.getStatus()
    setStatus(next)
  }

  const handleInstall = async (browser: ChatImportBrowserId): Promise<void> => {
    setInstalling(browser)
    try {
      const result = await window.api.chatImportSetup.install(browser)
      if (result.ok) {
        toast.success(
          translate(
            'auto.components.settings.WebChatBrowserLinkSection.installSuccess',
            'Browser linked.'
          )
        )
        // Re-read status so the badge flips to "linked" and the button relabels.
        await refreshStatus()
        return
      }
      toast.error(
        result.error ||
          translate(
            'auto.components.settings.WebChatBrowserLinkSection.installError',
            "Couldn't link the browser."
          )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.WebChatBrowserLinkSection.installError',
              "Couldn't link the browser."
            )
      )
    } finally {
      setInstalling(null)
    }
  }

  const copyExtensionDir = async (): Promise<void> => {
    if (!status) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(status.extensionDir)
      toast.success(
        translate(
          'auto.components.settings.WebChatBrowserLinkSection.copySuccess',
          'Copied the extension folder path.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.WebChatBrowserLinkSection.copyError',
              "Couldn't copy the path."
            )
      )
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.WebChatBrowserLinkSection.sectionTitle',
        'Browser linking'
      )}
      description={translate(
        'auto.components.settings.WebChatBrowserLinkSection.sectionDescription',
        'Detect your browsers, install the native messaging host, and load the Orca extension so web chats import automatically.'
      )}
      keywords={['browser', 'extension', 'native messaging', 'chrome', 'edge', 'brave', 'link']}
      className="space-y-4"
    >
      {status ? (
        <>
          <div className="space-y-2">
            {status.browsers.map((browser) => (
              <BrowserLinkRow
                key={browser.id}
                browser={browser}
                busy={installing === browser.id}
                onInstall={handleInstall}
              />
            ))}
          </div>

          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-foreground">
              {translate(
                'auto.components.settings.WebChatBrowserLinkSection.lastSyncedHeading',
                'Last synced'
              )}
            </h4>
            {SOURCE_ORDER.map((source) => (
              <LastSyncedRow
                key={source}
                label={SOURCE_LABELS[source]}
                value={status.lastSyncedBySource[source]}
              />
            ))}
          </div>

          <LoadGuide extensionDir={status.extensionDir} onCopy={copyExtensionDir} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.WebChatBrowserLinkSection.loading',
            'Checking browsers...'
          )}
        </p>
      )}
    </SearchableSetting>
  )
}

function browserBadge(status: ChatImportBrowserStatus): {
  tone: IntegrationStatusTone
  label: string
} {
  if (status.hostInstalled) {
    return {
      tone: 'connected',
      label: translate('auto.components.settings.WebChatBrowserLinkSection.badgeLinked', 'Linked')
    }
  }
  if (status.detected) {
    return {
      tone: 'attention',
      label: translate(
        'auto.components.settings.WebChatBrowserLinkSection.badgeNotInstalled',
        'Not installed'
      )
    }
  }
  return {
    tone: 'neutral',
    label: translate(
      'auto.components.settings.WebChatBrowserLinkSection.badgeNotDetected',
      'Not detected'
    )
  }
}

function BrowserLinkRow({
  browser,
  busy,
  onInstall
}: {
  browser: ChatImportBrowserStatus
  busy: boolean
  onInstall: (browser: ChatImportBrowserId) => Promise<void>
}): React.JSX.Element {
  const badge = browserBadge(browser)
  // Why: an undetected browser can't be linked, so the button is disabled — a
  // disabled button swallows pointer events, hence the span wrapper so the
  // "why is this off" tooltip still fires (STYLEGUIDE: no native title).
  const installButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!browser.detected || busy}
      onClick={() => void onInstall(browser.id)}
      className="shrink-0 gap-1.5"
    >
      <Download className="size-3.5" />
      {browser.hostInstalled
        ? translate('auto.components.settings.WebChatBrowserLinkSection.reinstall', 'Reinstall')
        : translate('auto.components.settings.WebChatBrowserLinkSection.install', 'Install')}
    </Button>
  )

  return (
    <div
      data-browser={browser.id}
      className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-background/50 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-medium text-foreground">{browser.label}</span>
        <IntegrationStatusPill tone={badge.tone}>{badge.label}</IntegrationStatusPill>
      </div>
      {browser.detected ? (
        installButton
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 cursor-not-allowed">{installButton}</span>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={6}>
            {translate(
              'auto.components.settings.WebChatBrowserLinkSection.notDetectedHint',
              "This browser wasn't detected on your system."
            )}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function LastSyncedRow({
  label,
  value
}: {
  label: string
  value: string | null
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">
        {value
          ? formatSyncedAgo(value)
          : translate('auto.components.settings.WebChatBrowserLinkSection.neverSynced', 'Never')}
      </span>
    </div>
  )
}

function LoadGuide({
  extensionDir,
  onCopy
}: {
  extensionDir: string
  onCopy: () => Promise<void>
}): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/30 p-3">
      <h4 className="text-xs font-semibold text-foreground">
        {translate(
          'auto.components.settings.WebChatBrowserLinkSection.guideHeading',
          'Load the extension'
        )}
      </h4>
      <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
        <li>
          {translate(
            'auto.components.settings.WebChatBrowserLinkSection.guideStep1',
            "Open your browser's extensions page (for example chrome://extensions)."
          )}
        </li>
        <li>
          {translate(
            'auto.components.settings.WebChatBrowserLinkSection.guideStep2',
            'Turn on Developer mode.'
          )}
        </li>
        <li>
          {translate(
            'auto.components.settings.WebChatBrowserLinkSection.guideStep3',
            'Choose "Load unpacked" and select the folder below.'
          )}
        </li>
      </ol>
      <div className="flex items-center gap-2">
        <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-background px-2 py-1 font-mono text-[11px]">
          {extensionDir}
        </code>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={translate(
                'auto.components.settings.WebChatBrowserLinkSection.copyPath',
                'Copy extension folder path'
              )}
              onClick={() => void onCopy()}
            >
              <Copy className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.settings.WebChatBrowserLinkSection.copyPath',
              'Copy extension folder path'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

// Compact relative-time formatter for per-source sync times; a source that has
// never synced renders the "never" state at the call site.
function formatSyncedAgo(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) {
    return translate('auto.components.settings.WebChatBrowserLinkSection.neverSynced', 'Never')
  }
  const diffMs = Date.now() - timestamp
  if (diffMs < 60_000) {
    return translate('auto.components.settings.WebChatBrowserLinkSection.justNow', 'Just now')
  }
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) {
    return translate(
      'auto.components.settings.WebChatBrowserLinkSection.minutesAgo',
      '{{value0}}m ago',
      { value0: minutes }
    )
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return translate(
      'auto.components.settings.WebChatBrowserLinkSection.hoursAgo',
      '{{value0}}h ago',
      {
        value0: hours
      }
    )
  }
  const days = Math.floor(hours / 24)
  return translate(
    'auto.components.settings.WebChatBrowserLinkSection.daysAgo',
    '{{value0}}d ago',
    {
      value0: days
    }
  )
}
