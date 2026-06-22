import { Fragment } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { JcodeCustomProvider } from '../../../../shared/jcode-chat-types'
import {
  JCODE_PROVIDERS,
  buildProfileOptions,
  findProfileOption,
  findProviderOption,
  groupCatalogRoutes,
  useJcodeModelCatalog
} from './jcode-providers'

// Why: the detailed model picker (Claude/Codex-app style) is its own component
// so the composer file stays under the repo's max-lines lint. It is driven by the
// REAL catalog (`jcode model list --json`): models grouped by provider, per-model
// availability, the current model checked, and an accurate "Auto → <resolved>".

// Custom profiles are namespaced so their React keys never collide with a
// built-in provider id.
const PROFILE_PREFIX = 'profile:'

export type ModelSelection = {
  provider?: string | undefined
  providerProfile?: string | undefined
  model?: string | undefined
}

export function ChatModelPicker({
  provider,
  providerProfile,
  model,
  customProviders,
  onSelectProvider
}: {
  /** Selected built-in provider id, or undefined for "Auto"/profile. */
  provider: string | undefined
  /** Selected custom provider profile name (mutually exclusive with provider). */
  providerProfile?: string | undefined
  model: string | undefined
  customProviders?: JcodeCustomProvider[]
  onSelectProvider: (selection: ModelSelection) => void
}): React.JSX.Element {
  const { catalog, loading: catalogLoading, refresh: refreshCatalog } = useJcodeModelCatalog()
  const modelGroups = groupCatalogRoutes(catalog)
  const catalogProviderIds = new Set(modelGroups.map((group) => group.providerId))
  // Built-in providers NOT present in the catalog (e.g. Gemini/OpenRouter that
  // aren't authed yet) stay reachable as provider-only picks under "更多 Provider".
  const otherProviders = JCODE_PROVIDERS.filter((entry) => !catalogProviderIds.has(entry.id))

  const profileOptions = buildProfileOptions(customProviders)
  const activeProfileOption = findProfileOption(customProviders, providerProfile)
  const isAuto = !provider && !providerProfile
  // Chip: show the concrete model when one is picked (Claude/Codex style), else
  // the provider label, else "Auto".
  const chipLabel = providerProfile
    ? model
      ? `${activeProfileOption?.label ?? providerProfile} · ${model}`
      : (activeProfileOption?.label ?? providerProfile)
    : model
      ? model
      : provider
        ? (findProviderOption(provider)?.label ?? provider)
        : 'Auto'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {chipLabel}
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] min-w-[17rem] overflow-y-auto scrollbar-sleek"
      >
        <DropdownMenuLabel>模型 Model</DropdownMenuLabel>

        {/* Auto — show what jcode actually resolves it to. */}
        <DropdownMenuItem
          onSelect={() =>
            onSelectProvider({ provider: undefined, providerProfile: undefined, model: undefined })
          }
        >
          <Check className={cn('size-3.5', isAuto ? 'opacity-100' : 'opacity-0')} />
          <span className="font-medium">Auto</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {catalog?.selectedModel ? `→ ${catalog.selectedModel}` : '自动选择'}
          </span>
        </DropdownMenuItem>

        {/* Real catalog, grouped by provider with per-model availability. */}
        {modelGroups.map((group) => (
          <Fragment key={group.providerDisplay}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.providerDisplay}
            </DropdownMenuLabel>
            {group.models.map((entry) => {
              const active = !providerProfile && provider === group.providerId && model === entry.id
              return (
                <DropdownMenuItem
                  key={entry.id}
                  onSelect={() =>
                    onSelectProvider({
                      provider: group.providerId,
                      providerProfile: undefined,
                      model: entry.id
                    })
                  }
                >
                  <Check className={cn('size-3.5', active ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn('truncate', !entry.available && 'text-muted-foreground')}>
                    {entry.id}
                  </span>
                  {!entry.available ? (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      需登录
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </Fragment>
        ))}

        {/* User-added custom OpenAI-compatible profiles. */}
        {profileOptions.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              自定义 Provider
            </DropdownMenuLabel>
            {profileOptions.map((entry) => {
              const active = providerProfile === entry.id
              return (
                <DropdownMenuItem
                  key={`${PROFILE_PREFIX}${entry.id}`}
                  onSelect={() =>
                    onSelectProvider({
                      provider: undefined,
                      providerProfile: entry.id,
                      model: entry.models?.[0]
                    })
                  }
                >
                  <Check className={cn('size-3.5', active ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{entry.label}</span>
                  {entry.models?.[0] ? (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {entry.models[0]}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              )
            })}
          </>
        ) : null}

        {/* Providers not in the catalog (not authed yet) — provider-only pick. */}
        {otherProviders.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>更多 Provider</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[50vh] overflow-y-auto scrollbar-sleek">
                {otherProviders.map((entry) => {
                  const active = !providerProfile && provider === entry.id && !model
                  return (
                    <DropdownMenuItem
                      key={entry.id}
                      onSelect={() =>
                        onSelectProvider({
                          provider: entry.id,
                          providerProfile: undefined,
                          model: undefined
                        })
                      }
                    >
                      <Check className={cn('size-3.5', active ? 'opacity-100' : 'opacity-0')} />
                      {entry.label}
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}

        {catalog && !catalog.ok ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              无法读取模型列表{catalog.error ? `:${catalog.error}` : ''}
            </div>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            // Keep the menu open so the user sees the refreshed list.
            event.preventDefault()
            refreshCatalog()
          }}
        >
          <RefreshCw className={cn('size-3.5', catalogLoading && 'animate-spin')} />
          刷新模型列表
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
