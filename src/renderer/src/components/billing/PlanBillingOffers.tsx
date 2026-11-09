import { useState } from 'react'
import { Building2, ExternalLink, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import {
  ORCA_BILLING_MAX_SEATS,
  type OrcaBillingInterval,
  type OrcaBillingOffers
} from '../../../../shared/orca-billing'
import { formatDollars } from './plan-billing-format'

export function TeamOffer({
  offers,
  busy,
  onCheckout
}: {
  offers: OrcaBillingOffers
  busy: boolean
  onCheckout: (args: { interval: OrcaBillingInterval; seats: number }) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [interval, setBillingInterval] = useState<OrcaBillingInterval>('month')
  const [seats, setSeats] = useState('1')
  const seatCount = Number(seats)
  const seatsValid =
    Number.isInteger(seatCount) && seatCount >= 1 && seatCount <= ORCA_BILLING_MAX_SEATS
  const team = offers.team
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4 text-muted-foreground" />
          {team.label}
        </p>
        <p className="text-xs text-muted-foreground">
          {interval === 'month' ? team.monthlyPriceLabel : team.annualPriceLabel}
        </p>
      </div>
      <ul className="flex-1 space-y-1 text-xs text-muted-foreground">
        <li>
          {t(
            'auto.components.billing.teamHoursPooled',
            '{{value0}} Standard sandbox hours per seat each month, pooled',
            {
              value0: String(team.includedHoursPerSeat)
            }
          )}
        </li>
        <li>
          {t(
            'auto.components.billing.teamConcurrency',
            '{{value0}} running sandboxes per seat · Large uses 2×',
            {
              value0: String(team.concurrentSandboxesPerSeat)
            }
          )}
        </li>
        <li>
          {t('auto.components.billing.teamIdle', 'Idle sandboxes sleep after {{value0}} minutes', {
            value0: String(team.idleSleepMinutes)
          })}
        </li>
        <li>
          {t(
            'auto.components.billing.teamOverage',
            'Optional overage at {{value0}}/hr with a spend cap',
            {
              value0: formatDollars(team.overageCentsPerHour)
            }
          )}
        </li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={interval === 'month' ? 'secondary' : 'ghost'}
          aria-pressed={interval === 'month'}
          onClick={() => setBillingInterval('month')}
        >
          {t('auto.components.billing.monthly', 'Monthly')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={interval === 'year' ? 'secondary' : 'ghost'}
          aria-pressed={interval === 'year'}
          onClick={() => setBillingInterval('year')}
        >
          {t('auto.components.billing.annual', 'Annual')}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {t('auto.components.billing.seatsLabel', 'Seats')}
        </span>
        <div className="w-16">
          <Input
            inputMode="numeric"
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
            aria-label={t('auto.components.billing.seatsLabel', 'Seats')}
          />
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={busy || !seatsValid}
        onClick={() => onCheckout({ interval, seats: seatCount })}
      >
        {t('auto.components.billing.upgrade', 'Upgrade')}
        <ExternalLink />
      </Button>
    </div>
  )
}

export function EnterpriseOffer({
  offers,
  onContactSales
}: {
  offers: OrcaBillingOffers
  onContactSales: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Building2 className="size-4 text-muted-foreground" />
          {offers.enterprise.label}
        </p>
        <p className="text-xs text-muted-foreground">{offers.enterprise.priceLabel}</p>
      </div>
      <p className="flex-1 text-xs text-muted-foreground">
        {t(
          'auto.components.billing.enterpriseDescription',
          'Run sandboxes in your own cloud, with SSO, audit logs and custom terms.'
        )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onContactSales(offers.enterprise.contactUrl)}
      >
        {t('auto.components.billing.contactUs', 'Contact us')}
        <ExternalLink />
      </Button>
    </div>
  )
}
