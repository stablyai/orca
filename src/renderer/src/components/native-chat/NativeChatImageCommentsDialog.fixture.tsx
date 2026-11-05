import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatImageCommentsDialog } from './NativeChatImageCommentsDialog'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#f5f6fa"/><rect width="210" height="800" fill="#192236"/><g fill="#c3cce0" font-family="sans-serif" font-size="22"><text x="28" y="66" fill="white" font-weight="bold">STUDIO</text><text x="28" y="146">Overview</text><text x="28" y="198">Campaigns</text><text x="28" y="250">Audience</text></g><g font-family="sans-serif"><text x="260" y="80" font-size="34" font-weight="bold" fill="#192236">Campaign overview</text><text x="260" y="119" font-size="20" fill="#67758e">Your team's progress this month</text><g fill="white"><rect x="260" y="165" width="270" height="140" rx="12"/><rect x="560" y="165" width="270" height="140" rx="12"/><rect x="860" y="165" width="270" height="140" rx="12"/><rect x="260" y="340" width="870" height="380" rx="12"/></g><g fill="#67758e" font-size="18"><text x="284" y="200">Revenue</text><text x="584" y="200">Subscribers</text><text x="884" y="200">Conversion</text></g><g fill="#192236" font-size="34" font-weight="bold"><text x="284" y="255">$24,850</text><text x="584" y="255">1,284</text><text x="884" y="255">4.8%</text></g><text x="286" y="390" font-size="24" fill="#192236">Audience growth</text></g><path d="M300 650 L420 600 L540 610 L670 540 L790 560 L910 470 L1080 430" fill="none" stroke="#607eea" stroke-width="5"/></svg>`
const image = () => Promise.resolve(new Blob([svg], { type: 'image/svg+xml' }))

export const preview = defineFixture({
  width: 1280,
  render: () => (
    <div className="h-[900px]">
      <NativeChatImageCommentsDialog
        image={image}
        title="Campaign preview"
        onClose={() => {}}
        onDone={async (dataUrl, text) => {
          document.documentElement.dataset.imageCommentResult = text
          document.documentElement.dataset.imageCommentPng = dataUrl
        }}
      />
    </div>
  )
})
