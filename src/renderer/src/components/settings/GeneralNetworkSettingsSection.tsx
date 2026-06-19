import type React from 'react'
import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { normalizeProxyBypassRules, normalizeProxyUrl } from '../../../../shared/network-proxy'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export type HttpProxyUrlDraftState = {
  sourceValue: string
  draft: string
  error: string | null
}

export function createHttpProxyUrlDraftState(
  httpProxyUrl: string | undefined
): HttpProxyUrlDraftState {
  const sourceValue = httpProxyUrl ?? ''
  return {
    sourceValue,
    draft: sourceValue,
    error: null
  }
}

function resolveHttpProxyUrlDraftState(
  state: HttpProxyUrlDraftState,
  httpProxyUrl: string | undefined
): HttpProxyUrlDraftState {
  const sourceValue = httpProxyUrl ?? ''
  return state.sourceValue === sourceValue ? state : createHttpProxyUrlDraftState(httpProxyUrl)
}

export function updateHttpProxyUrlDraftState(
  state: HttpProxyUrlDraftState,
  httpProxyUrl: string | undefined,
  draft: string
): HttpProxyUrlDraftState {
  return {
    // Why: settings persistence is async, so edits after an external settings
    // reload must build on the latest persisted proxy source.
    ...resolveHttpProxyUrlDraftState(state, httpProxyUrl),
    draft,
    error: null
  }
}

export function setHttpProxyUrlDraftErrorState(
  state: HttpProxyUrlDraftState,
  httpProxyUrl: string | undefined,
  error: string
): HttpProxyUrlDraftState {
  return {
    ...resolveHttpProxyUrlDraftState(state, httpProxyUrl),
    error
  }
}

export type HttpProxyBypassRulesDraftState = {
  sourceValue: string
  draft: string
}

export function createHttpProxyBypassRulesDraftState(
  httpProxyBypassRules: string | undefined
): HttpProxyBypassRulesDraftState {
  const sourceValue = httpProxyBypassRules ?? ''
  return {
    sourceValue,
    draft: sourceValue
  }
}

function resolveHttpProxyBypassRulesDraftState(
  state: HttpProxyBypassRulesDraftState,
  httpProxyBypassRules: string | undefined
): HttpProxyBypassRulesDraftState {
  const sourceValue = httpProxyBypassRules ?? ''
  return state.sourceValue === sourceValue
    ? state
    : createHttpProxyBypassRulesDraftState(httpProxyBypassRules)
}

export function updateHttpProxyBypassRulesDraftState(
  state: HttpProxyBypassRulesDraftState,
  httpProxyBypassRules: string | undefined,
  draft: string
): HttpProxyBypassRulesDraftState {
  return {
    ...resolveHttpProxyBypassRulesDraftState(state, httpProxyBypassRules),
    draft
  }
}

type GeneralNetworkSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralNetworkSettingsSection({
  settings,
  updateSettings
}: GeneralNetworkSettingsSectionProps): React.JSX.Element {
  const [httpProxyUrlDraftState, setHttpProxyUrlDraftState] = useState(() =>
    createHttpProxyUrlDraftState(settings.httpProxyUrl)
  )
  const [httpProxyBypassRulesDraftState, setHttpProxyBypassRulesDraftState] = useState(() =>
    createHttpProxyBypassRulesDraftState(settings.httpProxyBypassRules)
  )

  const resolvedHttpProxyUrlDraftState = resolveHttpProxyUrlDraftState(
    httpProxyUrlDraftState,
    settings.httpProxyUrl
  )
  if (resolvedHttpProxyUrlDraftState !== httpProxyUrlDraftState) {
    // Why: Settings can change outside this pane; reconcile the proxy draft
    // before paint so stale network values do not briefly appear.
    setHttpProxyUrlDraftState(resolvedHttpProxyUrlDraftState)
  }
  const httpProxyUrlDraft = resolvedHttpProxyUrlDraftState.draft
  const httpProxyUrlError = resolvedHttpProxyUrlDraftState.error

  const resolvedHttpProxyBypassRulesDraftState = resolveHttpProxyBypassRulesDraftState(
    httpProxyBypassRulesDraftState,
    settings.httpProxyBypassRules
  )
  if (resolvedHttpProxyBypassRulesDraftState !== httpProxyBypassRulesDraftState) {
    // Why: Proxy bypass rules are local input state, but settings reloads can
    // replace their source while this pane is mounted.
    setHttpProxyBypassRulesDraftState(resolvedHttpProxyBypassRulesDraftState)
  }
  const httpProxyBypassRulesDraft = resolvedHttpProxyBypassRulesDraftState.draft

  const updateHttpProxyUrlDraft = (draft: string): void => {
    setHttpProxyUrlDraftState((current) =>
      updateHttpProxyUrlDraftState(current, settings.httpProxyUrl, draft)
    )
  }

  const updateHttpProxyBypassRulesDraft = (draft: string): void => {
    setHttpProxyBypassRulesDraftState((current) =>
      updateHttpProxyBypassRulesDraftState(current, settings.httpProxyBypassRules, draft)
    )
  }

  const commitHttpProxyUrl = (): void => {
    const normalized = normalizeProxyUrl(httpProxyUrlDraft)
    if (!normalized.ok) {
      setHttpProxyUrlDraftState((current) =>
        setHttpProxyUrlDraftErrorState(current, settings.httpProxyUrl, normalized.message)
      )
      return
    }
    setHttpProxyUrlDraftState((current) =>
      updateHttpProxyUrlDraftState(current, settings.httpProxyUrl, normalized.value)
    )
    if (normalized.value !== (settings.httpProxyUrl ?? '')) {
      updateSettings({ httpProxyUrl: normalized.value })
    }
  }

  const commitHttpProxyBypassRules = (): void => {
    const normalized = normalizeProxyBypassRules(httpProxyBypassRulesDraft)
    setHttpProxyBypassRulesDraftState((current) =>
      updateHttpProxyBypassRulesDraftState(current, settings.httpProxyBypassRules, normalized)
    )
    if (normalized !== (settings.httpProxyBypassRules ?? '')) {
      updateSettings({ httpProxyBypassRules: normalized })
    }
  }

  return (
    <section key="network" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.GeneralNetworkSettingsSection.c46cdbbd4e',
          'Network'
        )}
        description={translate(
          'auto.components.settings.GeneralNetworkSettingsSection.d93c7cd531',
          'Configure app-level network routing.'
        )}
      />

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralNetworkSettingsSection.f00daf6324',
          'HTTP Proxy'
        )}
        description={translate(
          'auto.components.settings.GeneralNetworkSettingsSection.823e0f15b1',
          'Proxy URL for Orca network requests and local terminal children.'
        )}
        keywords={['proxy', 'http_proxy', 'https_proxy', 'network', 'dock', 'launchpad']}
        className="space-y-3"
      >
        <div className="space-y-1">
          <Label htmlFor="settings-http-proxy-url">
            {translate(
              'auto.components.settings.GeneralNetworkSettingsSection.f00daf6324',
              'HTTP Proxy'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralNetworkSettingsSection.1e214e265a',
              'Leave empty to use system proxy settings and inherited proxy environment variables.'
            )}
          </p>
        </div>
        <Input
          id="settings-http-proxy-url"
          value={httpProxyUrlDraft}
          onChange={(e) => {
            updateHttpProxyUrlDraft(e.target.value)
          }}
          onBlur={commitHttpProxyUrl}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
          placeholder={translate(
            'auto.components.settings.GeneralNetworkSettingsSection.476f302aca',
            'http://proxy.example.com:8080'
          )}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={httpProxyUrlError ? true : undefined}
          className="font-mono text-xs"
        />
        {httpProxyUrlError ? (
          <p className="text-xs text-destructive">{httpProxyUrlError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralNetworkSettingsSection.0adfce9fa7',
              'Supports http, https, socks, socks4, and socks5 URLs.'
            )}
          </p>
        )}
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralNetworkSettingsSection.f6d76cc8f4',
          'Proxy Bypass Rules'
        )}
        description={translate(
          'auto.components.settings.GeneralNetworkSettingsSection.fb7130dcb9',
          'Hosts that should bypass the configured HTTP proxy.'
        )}
        keywords={['proxy', 'bypass', 'no_proxy', 'localhost', 'network']}
        className="space-y-3"
      >
        <div className="space-y-1">
          <Label htmlFor="settings-http-proxy-bypass-rules">
            {translate(
              'auto.components.settings.GeneralNetworkSettingsSection.f6d76cc8f4',
              'Proxy Bypass Rules'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralNetworkSettingsSection.33ee3ca3af',
              'Optional. Separate hosts with commas, semicolons, or new lines.'
            )}
          </p>
        </div>
        <Input
          id="settings-http-proxy-bypass-rules"
          value={httpProxyBypassRulesDraft}
          onChange={(e) => updateHttpProxyBypassRulesDraft(e.target.value)}
          onBlur={commitHttpProxyBypassRules}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
          placeholder={translate(
            'auto.components.settings.GeneralNetworkSettingsSection.3e431564b5',
            'localhost, 127.0.0.1, *.internal'
          )}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
      </SearchableSetting>
    </section>
  )
}
