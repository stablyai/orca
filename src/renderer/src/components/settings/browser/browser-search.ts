import type { SettingsSearchEntry } from '../search/settings-search'
import { isMacUserAgent } from '../../../lib/user-agent-platform'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../search/settings-search-keywords'
import { getBrowserUserAgentSearchEntry } from './browser-user-agent-search'
import { getBrowserProfileScopeSearchEntry } from './profiles/browser-profile-scope-search'
import { getBrowserSitePermissionsSearchEntry } from './browser-site-permissions-search'
import {
  getBrowserLinkRoutingDescription,
  getLinkRoutingBackgroundSearchEntry,
  getLinkRoutingModifierDescription,
  getLinkRoutingModifierTitle
} from './routing/browser-link-routing-copy'
import {
  getBrowserClientHostedRemoteDescription,
  getBrowserClientHostedRemoteTitle
} from './routing/browser-client-hosted-remote-copy'
import {
  getBrowserSshWorkspaceRoutingDescription,
  getBrowserSshWorkspaceRoutingTitle
} from './routing/browser-ssh-workspace-routing-copy'
import {
  getTerminalLinkActionSearchKeywords,
  type BrowserShortcutPlatform
} from './routing/browser-terminal-link-action-search'

export function getBrowserPaneSearchEntries(
  platform: BrowserShortcutPlatform = { isMac: isMacUserAgent() },
  t: Translate = translate
): SettingsSearchEntry[] {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return [
    {
      title: t('auto.components.settings.browser.search.1c2aff8f82', 'Default home page'),
      description: t(
        'auto.components.settings.browser.search.a942905148',
        'URL opened when creating a new browser tab. Leave empty to open a blank tab.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword('auto.components.settings.browser.search.291f480a5e', 'home'),
        ...translateSearchKeyword('auto.components.settings.browser.search.0dbb1eaf4e', 'homepage'),
        ...translateSearchKeyword('auto.components.settings.browser.search.5448f4097b', 'default'),
        ...translateSearchKeyword('auto.components.settings.browser.search.4fda4fb066', 'url'),
        ...translateSearchKeyword('auto.components.settings.browser.search.483a0eb5e0', 'new tab'),
        ...translateSearchKeyword('auto.components.settings.browser.search.5164c47e31', 'blank'),
        ...translateSearchKeyword('auto.components.settings.browser.search.4596a52cf7', 'landing')
      ]
    },
    {
      title: t('auto.components.settings.browser.search.5a70844e54', 'Default search engine'),
      description: t(
        'auto.components.settings.browser.search.0628d5943b',
        'Search engine used when typing non-URL text in the address bar.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword('auto.components.settings.browser.search.16bd69cd82', 'search'),
        ...translateSearchKeyword('auto.components.settings.browser.search.72b4b89970', 'engine'),
        ...translateSearchKeyword('auto.components.settings.browser.search.8a489aab8d', 'google'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.1f8153acfb',
          'duckduckgo'
        ),
        ...translateSearchKeyword('auto.components.settings.browser.search.ad40e75d13', 'bing'),
        ...translateSearchKeyword('auto.components.settings.browser.search.e1c2a57f07', 'kagi'),
        ...translateSearchKeyword('auto.components.settings.browser.search.66dd641a47', 'session'),
        ...translateSearchKeyword('auto.components.settings.browser.search.0732ebe6fb', 'private'),
        ...translateSearchKeyword('auto.components.settings.browser.search.3538b3aaeb', 'token'),
        ...translateSearchKeyword('auto.components.settings.browser.search.8b8ed06e4b', 'omnibox'),
        ...translateSearchKeyword('auto.components.settings.browser.search.0bb34eacc9', 'query')
      ]
    },
    {
      title: t('auto.components.settings.browser.search.f6de9e25a0', 'Default zoom'),
      description: t(
        'auto.components.settings.browser.search.c3d89ed4d0',
        'Zoom level applied to newly opened browser tabs.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword('auto.components.settings.browser.search.4a98ed195f', 'zoom'),
        ...translateSearchKeyword('auto.components.settings.browser.search.54f4ea55f7', 'scale'),
        ...translateSearchKeyword('auto.components.settings.browser.search.5448f4097b', 'default'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.726f2a8556',
          'page zoom'
        ),
        ...translateSearchKeyword('auto.components.settings.browser.search.483a0eb5e0', 'new tab'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.95944898e0',
          'percentage'
        )
      ]
    },
    {
      title: t('auto.components.settings.browser.search.f0eb09ce09', 'Link routing'),
      description: getBrowserLinkRoutingDescription(platform, undefined, t),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword('auto.components.settings.browser.search.44d14df30d', 'preview'),
        ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.82ba1c80ea',
          'localhost'
        ),
        ...translateSearchKeyword('auto.components.settings.browser.search.72c58f7792', 'webview'),
        ...translateSearchKeyword('auto.components.settings.browser.search.90425d313c', 'shift'),
        platform.isMac ? 'cmd' : 'ctrl',
        ...translateSearchKeyword('auto.components.settings.browser.search.68d1db8929', 'markdown'),
        ...translateSearchKeyword('auto.components.settings.browser.search.8dd4805991', 'file'),
        ...translateSearchKeyword('auto.components.settings.browser.search.a7a07d5415', 'editor')
      ]
    },
    {
      title: getLinkRoutingModifierTitle(false, t),
      description: getLinkRoutingModifierDescription(
        {
          openLinksInApp: false,
          isMac: platform.isMac
        },
        t
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword('auto.components.settings.browser.search.bea27bac4b', 'links'),
        ...translateSearchKeyword('auto.components.settings.browser.search.90425d313c', 'shift'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.linkRoutingModifier.routing',
          'routing'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.linkRoutingModifier.modifier',
          'modifier'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.linkRoutingModifier.invert',
          'invert'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.linkRoutingModifier.opposite',
          'opposite'
        ),
        // Index the alternate live title because this entry is built with openLinksInApp false.
        getLinkRoutingModifierTitle(true, t),
        platform.isMac ? 'cmd' : 'ctrl'
      ]
    },
    {
      title: t(
        'auto.components.settings.BrowserTerminalLinkActionsSetting.title',
        'Terminal URL clicks'
      ),
      description: t(
        'auto.components.settings.BrowserTerminalLinkActionsSetting.descriptionV2',
        'Control clicks on detected URLs printed in terminal panes and chat transcripts.'
      ),
      keywords: getTerminalLinkActionSearchKeywords(platform, t)
    },
    {
      title: t('auto.components.settings.browser.search.e2e32ba6da', 'Localhost worktree labels'),
      description: t(
        'auto.components.settings.browser.search.4e0fdf0a3f',
        'Open workspace ports as worktree-specific Orca localhost URLs so browser tabs are easier to tell apart.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.82ba1c80ea',
          'localhost'
        ),
        ...translateSearchKeyword('auto.components.settings.browser.search.6f5199381e', 'ports'),
        ...translateSearchKeyword('auto.components.settings.browser.search.8f036ea11f', 'worktree'),
        ...translateSearchKeyword('auto.components.settings.browser.search.c4e3bf3282', 'tabs'),
        ...translateSearchKeyword('auto.components.settings.browser.search.a8c55c9c91', 'favicon'),
        ...translateSearchKeyword('auto.components.settings.browser.search.660c1dd007', 'labels')
      ]
    },
    {
      title: t('auto.components.settings.browser.search.f1da035bcb', 'Session & cookies'),
      description: t(
        'auto.components.settings.browser.search.060ac1fcba',
        'Import cookies from Chrome, Edge, or other browsers to use existing logins inside Orca.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.8a489aab8d', 'google'),
        ...translateSearchKeyword('browser.googleCookieClear.signInKeyword', 'sign-in'),
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword('auto.components.settings.browser.search.29193a51d5', 'cookies'),
        ...translateSearchKeyword('auto.components.settings.browser.search.66dd641a47', 'session'),
        ...translateSearchKeyword('auto.components.settings.browser.search.2e7f951773', 'import'),
        ...translateSearchKeyword('auto.components.settings.browser.search.3910a41f32', 'auth'),
        ...translateSearchKeyword('auto.components.settings.browser.search.854ef6ce83', 'login'),
        ...translateSearchKeyword('auto.components.settings.browser.search.75a0d435b7', 'chrome'),
        ...translateSearchKeyword('auto.components.settings.browser.search.533a253deb', 'edge'),
        ...translateSearchKeyword('auto.components.settings.browser.search.1c1e097985', 'arc'),
        ...translateSearchKeyword('auto.components.settings.browser.search.7539f6336c', 'profile')
      ]
    },
    // Append entries because BrowserPane indexes this catalog by position.
    {
      title: getBrowserClientHostedRemoteTitle(t),
      description: getBrowserClientHostedRemoteDescription(t),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.clientHostedRemote.remote',
          'remote'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.clientHostedRemote.client',
          'client'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.clientHostedRemote.host',
          'host'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.clientHostedRemote.desktop',
          'desktop'
        ),
        ...translateSearchKeyword('auto.components.settings.browser.search.72c58f7792', 'webview'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.clientHostedRemote.placement',
          'placement'
        )
      ]
    },
    {
      title: getBrowserSshWorkspaceRoutingTitle(t),
      description: getBrowserSshWorkspaceRoutingDescription(t),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.sshWorkspaceRouting.ssh',
          'ssh'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.sshWorkspaceRouting.proxy',
          'proxy'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.sshWorkspaceRouting.tunnel',
          'tunnel'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.sshWorkspaceRouting.routing',
          'routing'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.sshWorkspaceRouting.network',
          'network'
        )
      ]
    },
    getBrowserUserAgentSearchEntry(),
    getBrowserSitePermissionsSearchEntry(),
    getBrowserProfileScopeSearchEntry(),
    getLinkRoutingBackgroundSearchEntry(t)
  ]
}
