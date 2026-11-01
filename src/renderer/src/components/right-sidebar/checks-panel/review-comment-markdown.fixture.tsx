import { defineFixture } from '../../../component-fixtures/component-fixture'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { getPRCommentPresentationClasses } from '../pr-comment-presentation'
import { reviewCommentMarkdown } from './review-comment-markdown'

const iconBase = 'https://storage.googleapis.com/coderabbit_public_assets/review-comment-icons-v1/'
const content = `**<sub><sub><picture><img src="${iconBase}amber-16.svg" width="16" height="16" alt=""></picture></sub></sub> Minor** · **Functional Correctness** · **Quick win**

<details><summary><picture><source media="(prefers-color-scheme: dark)" srcset="${iconBase}review-details-dark.svg"><img src="${iconBase}review-details.svg" width="16" height="16" alt=""></picture> Supported by static analysis</summary>

The callback then discards the result from \`openChromeWebStore()\`.

</details>

**Handle rejected Web Store tab creation before completing the tour.**

\`performContextualTourStepAction\` calls \`finishTour()\` before it schedules \`openChromeWebStore()\`.

**<picture><img src="${iconBase}major-16.svg" width="16" height="16" alt=""></picture> Major** · **Security & Privacy**

**<picture><img src="${iconBase}critical-16.svg" width="16" height="16" alt=""></picture> Critical** · **Functional Correctness**`

export const narrow = defineFixture({
  width: 360,
  render: () => (
    <div className="bg-background p-3 text-foreground">
      <div className="rounded-lg border border-border bg-card p-4 text-[13px] leading-relaxed">
        <CommentMarkdown
          content={content}
          extension={reviewCommentMarkdown}
          className={getPRCommentPresentationClasses('cards').commentBodyMarkdown}
        />
      </div>
    </div>
  )
})

export const expanded = defineFixture({
  ...narrow,
  width: 540,
  interact: (frame) => {
    frame.querySelector('summary')?.click()
  }
})
