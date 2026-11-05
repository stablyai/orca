import React from 'react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function DialogComposerHeading({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <DialogHeader className="gap-1">
      <DialogTitle size="medium">{title}</DialogTitle>
      <DialogDescription className="sr-only">{description}</DialogDescription>
    </DialogHeader>
  )
}
