import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from '@/runtime/runtime-repo-search-bounds'
import { translate } from '@/i18n/i18n'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

type BaseRefPickerProps = {
  repoId: string
  hostId?: ExecutionHostId
  currentBaseRef?: string
  onSelect: (ref: string) => void
  onUsePrimary?: () => void
}

export function BaseRefPicker({
  repoId,
  hostId,
  currentBaseRef,
  onSelect,
  onUsePrimary
}: BaseRefPickerProps): React.JSX.Element {
  // Resolve refs on the explicit host or the repo row’s owner.
  const ownerHostId = useAppStore((state) => {
    if (hostId) {
      return hostId
    }
    const repo = findRepoForHost(state.repos, repoId, { settings: state.settings })
    return repo ? getRepoExecutionHostId(repo) : null
  })
  // Leave unknown defaults null; origin/main may not exist.
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)
  // Suppress multi-remote hints until a reliable count arrives; zero also represents failure (upstream-base-ref-design §4).
  const [remoteCount, setRemoteCount] = useState<number>(0)
  const [baseRefQuery, setBaseRefQuery] = useState('')
  const [baseRefResults, setBaseRefResults] = useState<string[]>([])
  const [isSearchingBaseRefs, setIsSearchingBaseRefs] = useState(false)
  const baseRefResultsListRef = useRef<HTMLDivElement>(null)

  // Radix scroll-lock cancels list wheel events; scroll manually as CommandList does.
  useEffect(() => {
    const el = baseRefResultsListRef.current
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollHeight <= el.clientHeight) {
        return
      }
      event.preventDefault()
      el.scrollTop += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [baseRefResults.length])

  useEffect(() => {
    let stale = false

    const loadDefaultBaseRef = async (): Promise<void> => {
      try {
        if (!ownerHostId) {
          return
        }
        const result = await getRuntimeRepoBaseRefDefault(ownerHostId, repoId)
        if (!stale) {
          setDefaultBaseRef(result.defaultBaseRef)
          setRemoteCount(result.remoteCount)
        }
      } catch (err) {
        console.error('[BaseRefPicker] getBaseRefDefault failed', err)
        if (!stale) {
          setDefaultBaseRef(null)
          setRemoteCount(0)
        }
      }
    }

    setBaseRefQuery('')
    setBaseRefResults([])
    // Drop the previous repo’s default before loading so its Following label cannot describe the new repo.
    setDefaultBaseRef(null)
    setRemoteCount(0)
    void loadDefaultBaseRef()

    return () => {
      stale = true
    }
  }, [ownerHostId, repoId])

  useEffect(() => {
    if (!isRuntimeRepoRefSearchQueryWithinLimit(baseRefQuery)) {
      setBaseRefResults([])
      setIsSearchingBaseRefs(false)
      return
    }
    const trimmedQuery = baseRefQuery.trim()
    if (trimmedQuery.length < 2 || !ownerHostId) {
      setBaseRefResults([])
      setIsSearchingBaseRefs(false)
      return
    }

    let stale = false
    setIsSearchingBaseRefs(true)

    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs(ownerHostId, repoId, trimmedQuery, 20)
        .then((results) => {
          if (!stale) {
            setBaseRefResults(results)
          }
        })
        .catch((err) => {
          console.error('[BaseRefPicker] searchBaseRefs failed', err)
          if (!stale) {
            setBaseRefResults([])
          }
        })
        .finally(() => {
          if (!stale) {
            setIsSearchingBaseRefs(false)
          }
        })
    }, 200)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [baseRefQuery, ownerHostId, repoId])

  const effectiveBaseRef = currentBaseRef ?? defaultBaseRef

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">
            {effectiveBaseRef ??
              translate('auto.components.settings.BaseRefPicker.ee110e1830', 'No default base ref')}
          </div>
          <p className="text-xs text-muted-foreground">
            {currentBaseRef
              ? translate(
                  'auto.components.settings.BaseRefPicker.2f3cda96f5',
                  'Pinned for this repo'
                )
              : defaultBaseRef
                ? translate(
                    'auto.components.settings.BaseRefPicker.086ce7f369',
                    'Following primary branch ({{value0}})',
                    { value0: defaultBaseRef }
                  )
                : translate(
                    'auto.components.settings.BaseRefPicker.9a14ec7400',
                    'Pick a base branch below'
                  )}
          </p>
          {/* Hint only with multiple known remotes; avoid assuming source names such as upstream (upstream-base-ref-design §4). */}
          {remoteCount > 1 ? (
            // Static instructions need no aria-live; avoid repeat announcements on mount/repo changes.
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.BaseRefPicker.a5c16712c1',
                'Multiple remotes detected. Type a remote name (e.g.'
              )}{' '}
              <code>
                {translate('auto.components.settings.BaseRefPicker.915ad97875', 'upstream')}
              </code>
              {translate(
                'auto.components.settings.BaseRefPicker.80f7c82303',
                ') or a full ref (e.g.'
              )}{' '}
              <code>
                {translate('auto.components.settings.BaseRefPicker.b468f46726', 'upstream/main')}
              </code>
              {translate(
                'auto.components.settings.BaseRefPicker.ade9a5bb03',
                ') to scope results.'
              )}
            </p>
          ) : null}
        </div>
        {onUsePrimary && (
          <Button variant="outline" size="sm" onClick={onUsePrimary} disabled={!currentBaseRef}>
            {translate('auto.components.settings.BaseRefPicker.773a5687a3', 'Use Primary')}
          </Button>
        )}
      </div>

      <Input
        value={baseRefQuery}
        onChange={(e) => setBaseRefQuery(e.target.value)}
        placeholder={translate(
          'auto.components.settings.BaseRefPicker.7db7fb87e5',
          'Search branches by name...'
        )}
        className="max-w-md"
      />

      {isSearchingBaseRefs ? (
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.settings.BaseRefPicker.a4a9372eb2', 'Searching branches...')}
        </p>
      ) : null}

      {!isSearchingBaseRefs && baseRefQuery.trim().length >= 2 ? (
        baseRefResults.length > 0 ? (
          <div
            ref={baseRefResultsListRef}
            className="max-h-[min(12rem,40vh)] overflow-y-auto overflow-x-hidden rounded-md border border-border/50 scrollbar-sleek"
          >
            <div className="p-1">
              {baseRefResults.map((ref) => (
                <button
                  key={ref}
                  onClick={() => {
                    // Return to rest after selection so search results cannot imply the new pin is still pending.
                    setBaseRefQuery('')
                    setBaseRefResults([])
                    onSelect(ref)
                  }}
                  className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${
                    effectiveBaseRef === ref
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground'
                  }`}
                >
                  <span className="truncate">{ref}</span>
                  {effectiveBaseRef === ref ? (
                    <span className="text-[10px] uppercase tracking-[0.18em]">
                      {translate('auto.components.settings.BaseRefPicker.d166ff883d', 'Current')}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BaseRefPicker.1b8e54151f',
              'No matching branches found.'
            )}
          </p>
        )
      ) : null}
    </div>
  )
}
