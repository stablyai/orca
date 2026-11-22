import React from 'react'
import { createLucideIcon } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'

// The mark of AgentQuestionIcon without its bubble, which the spinner replaces.
const QuestionMark = createLucideIcon('question-mark', [
  ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', key: 'mark' }],
  ['path', { d: 'M12 17h.01', key: 'dot' }]
])

/** The working ring around the question mark: the agent needs you and has not stopped. */
export function AgentWorkingQuestionIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      data-agent-working-question=""
      className={cn('relative block shrink-0', className)}
      aria-hidden="true"
    >
      {/* 1px outside the glyph box: inside it, the mark closes up at 10px. */}
      <AgentWorkingSpinner className="absolute -inset-px border-[1.5px]" />
      <QuestionMark className="absolute inset-0 size-full text-agent-question" strokeWidth={3.5} />
    </span>
  )
}
