import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

export function LargeDiffLoadPrompt({ onLoad }: { onLoad: () => void }): React.JSX.Element {
  return (
    <div
      data-testid="large-diff-load-prompt"
      className="flex h-full min-h-[120px] items-center justify-center border border-border bg-muted/10 px-4 py-6 text-muted-foreground"
    >
      <div className="space-y-3 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.editor.LargeDiffLoadPrompt.a0af0198aa',
            'Large diffs are not rendered by default.'
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            onLoad()
          }}
        >
          {translate('auto.components.editor.LargeDiffLoadPrompt.f7fa7a40d0', 'Load diff')}
        </Button>
      </div>
    </div>
  )
}
