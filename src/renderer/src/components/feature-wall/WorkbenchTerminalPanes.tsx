import type { JSX, ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { ClaudeIcon, OpenAIIcon } from '../status-bar/icons'
import type {
  WORKBENCH_RUN_QUEUE,
  WorkbenchTerminalLine
} from './workbench-terminal-storyboard-state'

export function WorkbenchSourceTerminalContent(props: {
  isTwoAgentsChecklist: boolean
  running: (typeof WORKBENCH_RUN_QUEUE)[number]
  reducedMotion: boolean
}): JSX.Element {
  return props.isTwoAgentsChecklist ? (
    <ClaudeChecklistPane reducedMotion={props.reducedMotion} />
  ) : (
    <PlaywrightPane running={props.running} reducedMotion={props.reducedMotion} />
  )
}

export function WorkbenchAgentTerminalPane(props: {
  splitOpen: boolean
  reducedMotion: boolean
  lines: readonly WorkbenchTerminalLine[]
  isCodex: boolean
  promptAccentClass: string
  showInputLine: boolean
  promptGlyph: '$' | '>'
  typedText: string
  showCaret: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 overflow-hidden border-l border-border px-3 py-2.5 transition-[opacity,transform] duration-[480ms] ease-[cubic-bezier(.2,.8,.2,1)]',
        props.reducedMotion ? 'transition-none' : null,
        props.splitOpen ? 'opacity-100' : 'translate-x-2 opacity-0'
      )}
      style={{ transitionDelay: props.splitOpen ? '200ms' : '0ms' }}
    >
      <RightPaneScrollback
        lines={props.lines}
        isCodex={props.isCodex}
        promptAccentClass={props.promptAccentClass}
      />
      {props.showInputLine ? (
        <TermLine wrap>
          <Prompt claude={props.promptGlyph === '>'}>{props.promptGlyph}</Prompt>
          <span className="text-foreground">{props.typedText}</span>
          {props.showCaret ? (
            <span className="ml-px inline-block h-[11px] w-[5px] -translate-y-px animate-pulse bg-foreground align-[-1px]" />
          ) : null}
        </TermLine>
      ) : null}
    </div>
  )
}

function PlaywrightPane(props: {
  running: (typeof WORKBENCH_RUN_QUEUE)[number]
  reducedMotion: boolean
}): JSX.Element {
  return (
    <>
      <TermLine>
        <Prompt>$</Prompt>
        <span className="text-foreground">
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.4371cc9931',
            'pnpm playwright test'
          )}
        </span>
      </TermLine>
      <TermLine muted>
        {translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.0b20782e0f',
          'Running 12 tests using 4 workers'
        )}
      </TermLine>
      <TermLine>
        <PassedCheck />
        <PlaywrightIndex>1</PlaywrightIndex>
        {translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.defe550fe2',
          'login.spec.ts'
        )}
        <PlaywrightName>
          {' '}
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.3261c6853b',
            '› can sign in'
          )}
        </PlaywrightName>
        <PlaywrightDuration>
          {translate('auto.components.feature.wall.WorkbenchAnimatedVisual.5c5cbd783f', '(1.2s)')}
        </PlaywrightDuration>
      </TermLine>
      <TermLine>
        <PassedCheck />
        <PlaywrightIndex>2</PlaywrightIndex>
        {translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.623881d72e',
          'checkout.spec.ts'
        )}
        <PlaywrightName>
          {' '}
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.944199e54a',
            '› cart total updates'
          )}
        </PlaywrightName>
        <PlaywrightDuration>
          {translate('auto.components.feature.wall.WorkbenchAnimatedVisual.7d9f1d5f7d', '(0.8s)')}
        </PlaywrightDuration>
      </TermLine>
      <TermLine>
        <RunSpinner reducedMotion={props.reducedMotion} />
        <PlaywrightIndex>3</PlaywrightIndex>
        {props.running.name}
        <PlaywrightName> {props.running.desc}</PlaywrightName>
      </TermLine>
    </>
  )
}

function ClaudeChecklistPane(props: { reducedMotion: boolean }): JSX.Element {
  return (
    <>
      <TermLine>
        <Prompt>$</Prompt>
        <span className="text-foreground">
          {translate('auto.components.feature.wall.WorkbenchAnimatedVisual.000106adfe', 'claude')}
        </span>
      </TermLine>
      <TermLine muted>
        <span className="mr-1.5 inline-flex align-[-2px]">
          <ClaudeIcon size={12} />
        </span>
        {translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.431ca9842a',
          'Claude Code session started'
        )}
      </TermLine>
      <TermLine wrap>
        <span className="mr-1.5 text-amber-600">
          {translate('auto.components.feature.wall.WorkbenchAnimatedVisual.932c4b3a97', '>')}
        </span>
        {translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.c0eb94125e',
          'review auth edge cases'
        )}
      </TermLine>
      <AgentAction action="Read" />
      <AgentAction action="Grep" />
      <TermLine>
        <RunSpinner reducedMotion={props.reducedMotion} />
        <span className="text-foreground">
          {translate('auto.components.feature.wall.WorkbenchAnimatedVisual.99f5224f1e', 'Edit')}
        </span>
        <span className="ml-1.5 truncate text-muted-foreground">
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.b85eab49dd',
            'src/auth/session.ts'
          )}
        </span>
      </TermLine>
    </>
  )
}

function AgentAction(props: { action: 'Read' | 'Grep' }): JSX.Element {
  const action =
    props.action === 'Read'
      ? translate('auto.components.feature.wall.WorkbenchAnimatedVisual.9923847785', 'Read')
      : translate('auto.components.feature.wall.WorkbenchAnimatedVisual.17cfdc3344', 'Grep')
  const target =
    props.action === 'Read'
      ? translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.b85eab49dd',
          'src/auth/session.ts'
        )
      : translate(
          'auto.components.feature.wall.WorkbenchAnimatedVisual.0d93c298a7',
          'throw src/auth'
        )
  return (
    <TermLine>
      <PassedCheck />
      <span className="text-foreground">{action}</span>
      <span className="ml-1.5 truncate text-muted-foreground">{target}</span>
    </TermLine>
  )
}

function RightPaneScrollback(props: {
  lines: readonly WorkbenchTerminalLine[]
  isCodex?: boolean
  promptAccentClass?: string
}): JSX.Element {
  return (
    <>
      {props.lines.map((line) => {
        const key = getWorkbenchTerminalLineKey(line)
        if (line.kind === 'submitted-command') {
          return (
            <TermLine key={key}>
              <Prompt>$</Prompt>
              <span className="text-foreground">{line.text}</span>
            </TermLine>
          )
        }
        if (line.kind === 'session-started') {
          return (
            <TermLine key={key} muted>
              {props.isCodex ? (
                <span aria-hidden className="mr-1.5 inline-flex text-foreground align-[-2px]">
                  <OpenAIIcon />
                </span>
              ) : (
                <span className="mr-1.5 text-foreground">●</span>
              )}
              {props.isCodex
                ? translate(
                    'auto.components.feature.wall.WorkbenchAnimatedVisual.fc84f17fe7',
                    'Codex session started'
                  )
                : translate(
                    'auto.components.feature.wall.WorkbenchAnimatedVisual.431ca9842a',
                    'Claude Code session started'
                  )}
            </TermLine>
          )
        }
        if (line.kind === 'submitted-prompt') {
          return (
            <TermLine key={key} wrap>
              <span className={cn('mr-1.5', props.promptAccentClass ?? 'text-amber-600')}>
                {translate('auto.components.feature.wall.WorkbenchAnimatedVisual.932c4b3a97', '>')}
              </span>
              {line.text}
            </TermLine>
          )
        }
        if (line.kind === 'thinking') {
          return (
            <TermLine key={key}>
              <RunSpinner />
              <span className="text-muted-foreground">
                {translate(
                  'auto.components.feature.wall.WorkbenchAnimatedVisual.633a91e358',
                  'Thinking…'
                )}
              </span>
            </TermLine>
          )
        }
        if (line.kind === 'agent-action') {
          return (
            <TermLine key={key}>
              {line.working ? <RunSpinner /> : <PassedCheck />}
              <span className="text-foreground">{line.action}</span>
              <span className="ml-1.5 truncate text-muted-foreground">{line.target}</span>
            </TermLine>
          )
        }
        return (
          <TermLine key={key}>
            {line.withGlyph ? (
              props.isCodex ? (
                <span aria-hidden className="mr-1.5 inline-flex text-foreground align-[-2px]">
                  <OpenAIIcon />
                </span>
              ) : (
                <span className="mr-1.5 text-amber-600">●</span>
              )
            ) : null}
            <span
              className="inline-block h-[7px] rounded-[3px] bg-foreground/[0.18] align-[1px]"
              style={{ width: `${line.widthPct}%` }}
            />
          </TermLine>
        )
      })}
    </>
  )
}

function getWorkbenchTerminalLineKey(line: WorkbenchTerminalLine): string {
  if (line.kind === 'submitted-command' || line.kind === 'submitted-prompt') {
    return `${line.kind}:${line.text}`
  }
  if (line.kind === 'agent-action') {
    return `${line.kind}:${line.action}:${line.target}`
  }
  if (line.kind === 'response-skeleton') {
    return `${line.kind}:${line.widthPct}`
  }
  return line.kind
}

function TermLine(props: { children: ReactNode; muted?: boolean; wrap?: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'leading-[1.45]',
        props.muted ? 'text-muted-foreground' : null,
        props.wrap ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-pre'
      )}
    >
      {props.children}
    </div>
  )
}

function Prompt(props: { children: ReactNode; claude?: boolean }): JSX.Element {
  return (
    <span className={cn('mr-1.5', props.claude ? 'text-amber-600' : 'text-emerald-600')}>
      {props.children}
    </span>
  )
}

function PassedCheck(): JSX.Element {
  return <span className="mr-1.5 font-bold text-emerald-600">✓</span>
}

function PlaywrightIndex(props: { children: ReactNode }): JSX.Element {
  return <span className="mr-1.5 text-muted-foreground">{props.children}</span>
}

function PlaywrightName(props: { children: ReactNode }): JSX.Element {
  return <span className="text-muted-foreground">{props.children}</span>
}

function PlaywrightDuration(props: { children: ReactNode }): JSX.Element {
  return <span className="ml-2 text-muted-foreground">{props.children}</span>
}

function RunSpinner(props: { reducedMotion?: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'mr-1.5 inline-block size-2 rounded-full border-[1.5px] border-foreground/20 align-[-1px]',
        props.reducedMotion ? 'border-t-foreground/20' : 'animate-spin border-t-foreground'
      )}
    />
  )
}
