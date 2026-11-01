import { defineFixture } from '../../../component-fixtures/component-fixture'
import { HomeSlide } from './HomeSlide'

function PhoneFrame({ width }: { width: number }): React.JSX.Element {
  return (
    <div className="mobile-page-root" style={{ height: 'auto', overflow: 'visible' }}>
      <div className="mp-phone-frame" style={{ width }}>
        <div className="mp-phone-screen">
          <HomeSlide tapping={false} />
        </div>
      </div>
    </div>
  )
}

// The carousel's largest frame and the narrow-layout frame.
export const large = defineFixture({ width: 440, render: () => <PhoneFrame width={420} /> })

export const narrow = defineFixture({ width: 310, render: () => <PhoneFrame width={290} /> })
