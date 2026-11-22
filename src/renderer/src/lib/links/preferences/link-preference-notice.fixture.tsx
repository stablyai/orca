import { useEffect } from 'react'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../../shared/i18n/ui-language'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  dismissLinkPreferenceNotice,
  showLinkPreferenceNotice,
  type LinkPreferenceNoticeKind
} from './link-preference-notice'

function Notice({
  notice,
  language
}: {
  notice: LinkPreferenceNoticeKind
  language?: UiLanguage
}): React.JSX.Element {
  useEffect(() => {
    // The title is read when shown, so switch language first.
    void (language ? setRendererUiLanguage(language) : Promise.resolve()).then(() =>
      showLinkPreferenceNotice(notice)
    )
    return () => dismissLinkPreferenceNotice()
  }, [notice, language])
  return (
    <>
      <div className="h-[120px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

const notice = (
  kind: LinkPreferenceNoticeKind,
  language?: UiLanguage
): ReturnType<typeof defineFixture> =>
  defineFixture({
    width: 420,
    render: () => <Notice notice={kind} {...(language ? { language } : {})} />
  })

export const savedSystem = notice({ kind: 'saved', openLinksInApp: false })
export const savedOrca = notice({ kind: 'saved', openLinksInApp: true })
export const failed = notice({ kind: 'failed' })
export const unknown = notice({ kind: 'unknown' })
export const unknownGerman = notice({ kind: 'unknown' }, 'de')
export const unknownRussian = notice({ kind: 'unknown' }, 'ru')
