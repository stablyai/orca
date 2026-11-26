import { useEffect, useState } from 'react'
import { setRendererUiLanguage } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../shared/i18n/ui-language'
import { buildHttpLinkActions } from '@/lib/browser/navigation/http-link-destinations'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { LinkActionPopover } from './LinkActionPopover'
import type { LinkActionRequest } from './link-action-request'

function urlRequest(rememberEligible: boolean): LinkActionRequest {
  return {
    anchorX: 24,
    anchorY: 24,
    destination: 'https://example.com/docs/getting-started',
    kind: 'url',
    // The real row labels, read after the fixture language is loaded.
    ...buildHttpLinkActions({ primary: 'system', alternate: 'orca' }, () => {}),
    restoreFocus: () => {},
    ...(rememberEligible ? { linkPreferenceHost: true, rememberEligible: true } : {})
  }
}

function Chooser({
  rememberEligible,
  language
}: {
  rememberEligible: boolean
  language?: UiLanguage
}): React.JSX.Element {
  const [request, setRequest] = useState<LinkActionRequest | null>(null)
  useEffect(() => {
    void (language ? setRendererUiLanguage(language) : Promise.resolve()).then(() =>
      setRequest(urlRequest(rememberEligible))
    )
  }, [language, rememberEligible])
  return (
    <div className="h-[230px] bg-background">
      <LinkActionPopover request={request} onClose={() => {}} onOpenSettings={() => {}} />
    </div>
  )
}

async function tickRemember(): Promise<void> {
  const deadline = performance.now() + 3000
  let row = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
  while (!row && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    row = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
  }
  row?.click()
}

const chooser = (
  rememberEligible: boolean,
  language?: UiLanguage,
  tick = false
): ReturnType<typeof defineFixture> =>
  defineFixture({
    width: 340,
    render: () => (
      <Chooser rememberEligible={rememberEligible} {...(language ? { language } : {})} />
    ),
    ...(tick ? { interact: tickRemember } : {})
  })

/** Chat, terminal or dashboard plain click in Ask: the two browsers plus the Remember row. */
export const rememberRow = chooser(true)
export const rememberRowTicked = chooser(true, undefined, true)
export const rememberRowGerman = chooser(true, 'de')
export const rememberRowRussian = chooser(true, 'ru')
/** Sidebar and activity links keep today's chooser with no Remember row. */
export const withoutRemember = chooser(false)
