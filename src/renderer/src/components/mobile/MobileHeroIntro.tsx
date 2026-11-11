import { ArrowRight } from 'lucide-react'
import { AndroidLogo, IosBrandIcon } from './MobileBrandIcons'
import { useTranslate } from '@/i18n/use-translate'

export function HeroIntro({ onStart }: { onStart: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mp-intro-shell">
      <div className="mp-eyebrow-row">
        <span className="mp-eyebrow">
          {t('auto.components.mobile.MobileHero.5410d55d79', 'Orca Mobile')}
        </span>
      </div>
      <h1 className="mp-h1">
        {t('auto.components.mobile.MobileHero.cd4e5e816f', 'Your workspaces, in your pocket.')}
      </h1>
      <p className="mp-lead">
        {t(
          'auto.components.mobile.MobileHero.b4ccce5cb7',
          "Control Orca from your phone. Check on agents, review changes, and kick off tasks while you're away from your desk."
        )}
      </p>
      <div
        className="mp-platform-badges"
        aria-label={t('auto.components.mobile.MobileHero.ec0607bf66', 'Supported mobile platforms')}
      >
        <span className="mp-platform-label">
          {t('auto.components.mobile.MobileHero.da1d5e5ed0', 'Available on')}
        </span>
        <span className="mp-platform-badge">
          <IosBrandIcon />
          {t('auto.components.mobile.MobileHero.711e6f4b47', 'iOS')}
        </span>
        <span className="mp-platform-badge">
          <AndroidLogo />
          {t('auto.components.mobile.MobileHero.ac1eb64952', 'Android')}
        </span>
      </div>
      <div className="mp-cta-row">
        <button
          type="button"
          className="mp-primary-action mp-flow-primary-action"
          onClick={onStart}
        >
          {t('auto.components.mobile.MobileHero.10d27b4cba', 'Get started')}
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
