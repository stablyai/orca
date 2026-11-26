import type { ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SUPPORTED_UI_LOCALES } from '../../../../shared/i18n/ui-locale'
import { getUiLanguageNativeLabel } from '@/i18n/supported-languages'
import type { LanguageRowModel } from './LanguagePackRow'
import { LanguagePickerView, type LanguagePickerViewProps } from './LanguagePickerView'
import { languageNames } from './language-pack-options'

const noop = (): void => {}

// Why: the real dialog portals and centers on the viewport; render its surface inline so the
// capture hugs the content and the width can be narrowed. The X mirrors DialogContent's own.
function DialogSurface({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Dialog open>
      <div className="relative flex flex-col overflow-hidden rounded-lg border border-black/14 bg-dialog-surface text-foreground shadow-[0_20px_60px_rgba(0,0,0,0.28)] dark:border-white/14">
        {children}
        <XIcon aria-hidden="true" className="absolute top-4 right-4 size-4 opacity-70" />
      </div>
    </Dialog>
  )
}

function builtIns(current: string, extra: Partial<LanguageRowModel> = {}): LanguageRowModel[] {
  return [
    { id: 'system', name: 'System', hint: 'English', hintLang: 'en' },
    ...SUPPORTED_UI_LOCALES.map((locale) => {
      const english = languageNames(locale).english
      const name = getUiLanguageNativeLabel(locale)
      return { id: locale, name, nameLang: locale, hint: english === name ? undefined : english }
    })
  ].map((row) => ({
    ...row,
    selected: row.id === current,
    onSelect: noop,
    ...(row.id === extra.id ? extra : {})
  }))
}

function pack(
  locale: string,
  publisher: string,
  extra: Partial<LanguageRowModel> = {}
): LanguageRowModel {
  const names = languageNames(locale)
  return {
    id: `plugin:${publisher}.lang/${locale}`,
    name: names.native,
    nameLang: locale,
    hint: names.english,
    selected: false,
    needsInstall: true,
    onSelect: noop,
    ...extra
  }
}

type Overrides = Partial<Record<'ebbop' | 'matteo' | 'uk' | 'vi', Partial<LanguageRowModel>>>

/** Two italiano packs (publisher shown to tell them apart), plus two other languages. */
function packs(overrides: Overrides = {}) {
  return {
    ebbop: pack('it', 'ebbop', { publisher: 'ebbop', needsInstall: false, ...overrides.ebbop }),
    matteo: pack('it', 'matteoeusebi', { publisher: 'matteoeusebi', ...overrides.matteo }),
    uk: pack('uk', 'mancunianez', overrides.uk),
    vi: pack('vi-VN', 'dohaidang', overrides.vi)
  }
}

/** Device is Italian: ebbop's pack is pinned first; the rest stay in the community group. */
function devicePinned(overrides: Overrides = {}) {
  const all = packs({
    ...overrides,
    ebbop: { device: true, autoFocusTarget: true, ...overrides.ebbop }
  })
  return { pinned: all.ebbop, community: [all.matteo, all.uk, all.vi] }
}

function allCommunity(overrides: Overrides = {}): LanguageRowModel[] {
  const all = packs(overrides)
  return [all.ebbop, all.matteo, all.uk, all.vi]
}

const base: LanguagePickerViewProps = {
  onboarding: false,
  query: '',
  onQueryChange: noop,
  pinned: null,
  builtIns: builtIns('system'),
  community: allCommunity(),
  catalogStatus: 'ready',
  catalogSupported: true,
  pluginsDisabled: false,
  refreshing: false,
  busy: false,
  footerBusy: false,
  onRefresh: noop,
  failedLanguage: null,
  onRetryLanguage: noop,
  error: null,
  switchBackTo: null,
  onSwitchBack: noop,
  requesting: false,
  onRequest: noop,
  onRequestBack: noop,
  onManagePlugins: noop,
  onDone: noop
}

// Why: built-ins come first, so community states sit below the fold until the list scrolls.
function scrollToCommunity(frame: HTMLElement): void {
  const list = frame.querySelector<HTMLElement>('[aria-busy]')
  const community = frame.querySelector<HTMLElement>('[data-community-group]')
  if (list && community) {
    list.scrollTop = community.offsetTop - 4
  }
}

function picker(
  props: Partial<LanguagePickerViewProps>,
  { width = 544, scroll = false }: { width?: number; scroll?: boolean } = {}
) {
  return defineFixture({
    width,
    interact: scroll ? scrollToCommunity : undefined,
    render: () => (
      <DialogSurface>
        <LanguagePickerView {...base} {...props} />
      </DialogSurface>
    )
  })
}

/** Device is Italian (not built in) and ebbop's pack is installed: pinned, one click to switch. */
export const suggested = picker(devicePinned())

/** The device pack isn't installed yet: the pinned row offers "Get". */
export const suggestedNeedsInstall = picker(devicePinned({ ebbop: { needsInstall: true } }))

/** Reading the pack before the trust prompt: nothing claims "Installing" until consent. */
export const suggestionPreparing = picker({
  busy: true,
  ...devicePinned({
    ebbop: { needsInstall: true, busy: true, installPhase: 'preparing', disabled: true },
    matteo: { disabled: true },
    uk: { disabled: true },
    vi: { disabled: true }
  })
})

export const rowInstalling = picker({
  busy: true,
  footerBusy: true,
  ...devicePinned({
    ebbop: { needsInstall: true, busy: true, installPhase: 'installing', disabled: true },
    matteo: { disabled: true },
    uk: { disabled: true },
    vi: { disabled: true }
  })
})

/** Device language is built in: no pinned row, built-ins lead. */
export const deviceBuiltIn = picker({ builtIns: builtIns('system', { id: 'en', device: true }) })

export const deviceBuiltInLoading = picker({ community: [], catalogStatus: 'loading' })

export const communityActive = picker({
  builtIns: builtIns('plugin:ebbop.lang/it'),
  ...devicePinned({ ebbop: { selected: true } }),
  switchBackTo: { name: 'System' }
})

export const loadingCatalog = picker({ community: [], catalogStatus: 'loading' }, { scroll: true })

export const catalogError = picker({ community: [], catalogStatus: 'error' }, { scroll: true })

export const searchNoResults = picker({ query: 'klingon', builtIns: [], community: [] })

export const searchMatches = picker({
  query: 'ital',
  builtIns: [],
  community: allCommunity().filter((row) => row.nameLang === 'it')
})

export const rowInstallingScrolled = picker(
  {
    busy: true,
    footerBusy: true,
    community: allCommunity({
      ebbop: { disabled: true },
      matteo: { busy: true, installPhase: 'installing', disabled: true },
      uk: { disabled: true },
      vi: { disabled: true }
    })
  },
  { scroll: true }
)

export const rowError = picker(
  {
    community: allCommunity({
      uk: { error: 'Could not install this plugin. Check your connection and try again.' }
    })
  },
  { scroll: true }
)

export const installedButUnusable = picker(
  devicePinned({ ebbop: { error: 'Installed, but this translation can’t load yet.' } })
)

export const incompletePack = picker(
  {
    community: [...allCommunity(), pack('pl', 'kowalski', { coverage: 41, needsInstall: false })]
  },
  { scroll: true }
)

export const pluginsDisabled = picker({
  pluginsDisabled: true,
  community: allCommunity().map((row) => ({ ...row, unavailable: true }))
})

export const languageLoadFailed = picker({
  failedLanguage: { name: 'italiano' },
  builtIns: builtIns('none', { id: 'en', effective: true }),
  ...devicePinned({ ebbop: { failed: true } }),
  switchBackTo: { name: 'System' }
})

export const onboarding = picker({
  onboarding: true,
  onManagePlugins: undefined,
  ...devicePinned()
})

/** Plugins run only on desktop: no catalog, no Get, no Plugins links. */
export const webClient = picker({
  catalogSupported: false,
  community: [],
  onRequest: undefined,
  onManagePlugins: undefined
})

export const requestForm = picker({ requesting: true })

export const requestFormPrefilled = picker({ requesting: true, requestDraft: 'klingon' })

export const narrow = picker(devicePinned({ ebbop: { needsInstall: true } }), { width: 452 })

export const narrowCommunityActive = picker(
  {
    builtIns: builtIns('plugin:ebbop.lang/it'),
    ...devicePinned({ ebbop: { selected: true } }),
    switchBackTo: { name: 'English', lang: 'en' }
  },
  { width: 452 }
)

export const narrowNoMatches = picker(
  { query: 'klingon', builtIns: [], community: [] },
  { width: 452 }
)
