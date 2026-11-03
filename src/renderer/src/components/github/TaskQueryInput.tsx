import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject
} from 'react'
import { ListFilter, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

const parameters = [
  'is:pr',
  'is:issue',
  'is:open',
  'is:closed',
  'is:merged',
  'is:draft',
  'state:all',
  'author:',
  'assignee:',
  'label:',
  'review-requested:',
  'reviewed-by:',
  'sort:',
  'AND',
  'OR'
]

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'ref'> & {
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  showClear: boolean
  onClear: () => void
}

export default function TaskQueryInput({
  value,
  inputRef,
  showClear,
  onClear,
  className,
  ...props
}: Props): React.JSX.Element {
  const [composing, setComposing] = useState(false)
  const overlayRef = useRef<HTMLSpanElement>(null)
  const tokens = Array.from(
    value.matchAll(/\s+|[()]|(?:"(?:\\.|[^"\\])*"?|(?<=^|[\s:(-])'(?:\\.|[^'\\])*'?|[^\s"()])+/gu)
  )
  const syncScroll = useCallback((): void => {
    if (overlayRef.current && inputRef.current) {
      overlayRef.current.style.transform = `translateX(${-inputRef.current.scrollLeft}px)`
    }
  }, [inputRef])
  useLayoutEffect(syncScroll, [value, composing, syncScroll])

  function appendParameter(parameter: string): void {
    const input = inputRef.current
    if (!input || props.disabled) {
      return
    }
    const separator = input.value && !/\s$/u.test(input.value) ? ' ' : ''
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.ownerDocument.execCommand('insertText', false, `${separator}${parameter}`)
  }

  return (
    <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="menu" disabled={props.disabled}>
            <ListFilter className="size-3.5" />
            {translate('auto.components.github.PRFilterDropdowns.79c54552f7', 'Filters')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            const input = inputRef.current
            if (input?.ownerDocument.activeElement === input) {
              event.preventDefault()
            }
          }}
        >
          {parameters.map((parameter) => (
            <DropdownMenuItem
              key={parameter}
              disabled={props.disabled}
              onSelect={() => appendParameter(parameter)}
            >
              {parameter}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        className={cn(
          'relative min-w-0 flex-1 rounded-md bg-background',
          !composing && 'dark:bg-input/30'
        )}
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          {...props}
          ref={inputRef}
          value={value}
          autoComplete="off"
          spellCheck={false}
          density="search"
          variant={composing ? 'default' : 'overlay'}
          className={className}
          onScroll={(event) => {
            syncScroll()
            props.onScroll?.(event)
          }}
          onCompositionStart={(event) => {
            setComposing(true)
            props.onCompositionStart?.(event)
          }}
          onCompositionEnd={(event) => {
            setComposing(false)
            props.onCompositionEnd?.(event)
          }}
          onBlur={(event) => {
            setComposing(false)
            props.onBlur?.(event)
          }}
        />
        {!composing && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-px left-[calc(var(--spacing)*8+1px)] right-[calc(var(--spacing)*8+1px)] flex items-center overflow-hidden text-xs text-foreground md:text-sm"
          >
            <span
              ref={overlayRef}
              className="shrink-0 whitespace-pre"
              data-task-query-highlights=""
            >
              {tokens.map((token) => {
                const qualifier = token[0].match(/^(-?[a-z][\w-]*:)([\s\S]*)$/iu)
                return qualifier ? (
                  <Fragment key={token.index}>
                    <span>{qualifier[1]}</span>
                    <span className="bg-task-query-highlight text-task-query-highlight-foreground">
                      {qualifier[2]}
                    </span>
                  </Fragment>
                ) : (
                  <span
                    key={token.index}
                    className={
                      /^(AND|OR)$/u.test(token[0])
                        ? 'bg-task-query-highlight text-task-query-highlight-foreground'
                        : undefined
                    }
                  >
                    {token[0]}
                  </span>
                )
              })}
            </span>
          </div>
        )}
        {showClear && (
          <button
            type="button"
            aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
            onClick={onClear}
            className="absolute right-3 top-1/2 z-20 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  )
}
