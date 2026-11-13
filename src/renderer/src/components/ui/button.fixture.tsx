import { GitBranch, Plus, Trash2 } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Button } from './button'

const VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const
const SIZES = ['xs', 'sm', 'default', 'lg'] as const

export const variants = defineFixture({
  width: 640,
  render: () => (
    <div className="flex flex-col gap-3">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex items-center gap-2">
          <span className="w-20 text-xs text-muted-foreground">{variant}</span>
          <Button variant={variant}>Create workspace</Button>
          <Button variant={variant}>
            <Plus />
            With icon
          </Button>
          <Button variant={variant} disabled>
            Disabled
          </Button>
        </div>
      ))}
    </div>
  )
})

export const sizes = defineFixture({
  width: 640,
  render: () => (
    <div className="flex flex-col gap-3">
      {SIZES.map((size) => (
        <div key={size} className="flex items-center gap-2">
          <span className="w-20 text-xs text-muted-foreground">{size}</span>
          <Button size={size} variant="outline">
            <GitBranch />
            Checkout
          </Button>
          <Button size={size}>Commit</Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="w-20 text-xs text-muted-foreground">icon</span>
        <Button size="icon-xs" variant="ghost" aria-label="Delete">
          <Trash2 />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Delete">
          <Trash2 />
        </Button>
        <Button size="icon" variant="outline" aria-label="Delete">
          <Trash2 />
        </Button>
      </div>
    </div>
  )
})

function focusedButtonFixture(variant: (typeof VARIANTS)[number]) {
  return defineFixture({
    width: 320,
    render: () => (
      <div className="flex items-center justify-center gap-3 p-4">
        <Button variant="outline">Cancel</Button>
        <Button variant={variant} data-fixture-focus>
          {variant === 'destructive' ? <Trash2 /> : <Plus />}
          {variant === 'destructive' ? 'Delete' : 'Create'}
        </Button>
      </div>
    ),
    interact: (frame) => frame.querySelector<HTMLButtonElement>('[data-fixture-focus]')?.focus()
  })
}

export const focusedPrimary = focusedButtonFixture('default')

export const focusedDestructive = focusedButtonFixture('destructive')

export const focusedOutline = focusedButtonFixture('outline')
